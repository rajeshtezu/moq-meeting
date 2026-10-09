import { Catalog, Container } from "@moq/hang";
import type * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { Tracks } from "@moq-meeting/shared";
import { toHex, type VideoRendition } from "./catalog";
import { type MediaClock, Rebase } from "./clock";
import { RateController } from "./rate";

/** What the connection can tell a sender about its uplink. */
export interface NetworkSignals {
	/** The connection's send-side bandwidth allocator. */
	bandwidth?: Moq.Bandwidth.Handle;
	/** Relay-measured round trip, ms (PROBE). */
	rtt?: number;
}

export interface VideoProfile {
	/** Capture constraints; the encoder is sized from the actual frames. */
	width: number;
	height: number;
	framerate: number;
	bitrate: number;
	/** Adaptive bitrate floor: below this, the relay dropping groups beats a mushy picture. */
	minBitrate: number;
	/** A keyframe (and so a new group) this often bounds join time and loss recovery. */
	keyframeIntervalUs: number;
	/** Tried in order; the first the browser can encode wins. */
	codecs: Pick<VideoEncoderConfig, "codec" | "avc">[];
	contentHint?: "motion" | "detail" | "text";
}

/** Camera: one 360p rendition. H.264 baseline first (hardware-friendly), VP8 fallback (intake Q3). */
export const CAMERA: VideoProfile = {
	width: 640,
	height: 360,
	framerate: 30,
	bitrate: 800_000,
	minBitrate: 150_000,
	keyframeIntervalUs: 2_000_000,
	codecs: [{ codec: "avc1.42E01F", avc: { format: "annexb" } }, { codec: "vp8" }],
	contentHint: "motion",
};

/**
 * Screen share: up to 1080p at a low frame rate. Text needs resolution more than motion, so
 * more bits per frame. H.264 level 4.0 covers 1920×1080.
 */
export const SCREEN: VideoProfile = {
	width: 1920,
	height: 1080,
	framerate: 15,
	bitrate: 2_000_000,
	minBitrate: 300_000,
	keyframeIntervalUs: 3_000_000,
	codecs: [{ codec: "avc1.42E028", avc: { format: "annexb" } }, { codec: "vp8" }],
	contentHint: "detail",
};

async function pickCodec(profile: VideoProfile, width: number, height: number): Promise<VideoEncoderConfig> {
	for (const candidate of profile.codecs) {
		const config: VideoEncoderConfig = {
			...candidate,
			width,
			height,
			bitrate: profile.bitrate,
			framerate: profile.framerate,
			latencyMode: "realtime",
		};
		const { supported } = await VideoEncoder.isConfigSupported(config);
		if (supported) return config;
	}
	throw new Error(
		`no supported video encoder for ${width}x${height} (tried ${profile.codecs.map((c) => c.codec).join(", ")})`,
	);
}

/**
 * Video track (camera or screen) → VideoEncoder → hang legacy container on the `video` track.
 * `Legacy.Producer` starts a new MoQ group at every keyframe, so each group is one GoP.
 * If the frame size changes (a shared window is resized), the encoder is reconfigured and
 * the catalog updated; the next frame is a keyframe.
 */
export class VideoPublisher {
	readonly #producer: Container.Legacy.Producer;
	readonly #source: MediaStreamTrack;
	readonly #rebase: Rebase;
	readonly #onRendition: (r: VideoRendition) => void;
	readonly #profile: VideoProfile;
	#reader: ReadableStreamDefaultReader<VideoFrame> | undefined;
	#encoder: VideoEncoder | undefined;
	#config: VideoEncoderConfig | undefined;
	readonly #track: Moq.Track.Producer;
	readonly #network: (() => NetworkSignals) | undefined;
	readonly #rate: RateController;
	#reservation: { handle: Moq.Bandwidth.Handle; reservation: Moq.Bandwidth.Reservation } | undefined;
	readonly #abrTimer: ReturnType<typeof setInterval>;
	/** The encoder's current target and the allocator's latest grant, for the local stats overlay. */
	readonly send = { bitrate: 0, grant: undefined as number | undefined, rtt: undefined as number | undefined };
	#enabled = true;
	#frameCount = 0;
	#forceKeyframe = false;
	#closed = false;

	constructor(
		source: MediaStreamTrack,
		broadcast: Moq.Broadcast.Producer,
		clock: MediaClock,
		onRendition: (r: VideoRendition) => void,
		profile: VideoProfile = CAMERA,
		/**
		 * Uplink signals. When given, the encoder bitrate adapts between minBitrate and bitrate
		 * (see RateController), so a slow uplink gets a lighter stream instead of the relay
		 * dropping whole groups.
		 */
		network?: () => NetworkSignals,
	) {
		this.#network = network;
		this.#rate = new RateController({ min: profile.minBitrate, max: profile.bitrate });
		this.#source = source;
		this.#profile = profile;
		if (profile.contentHint) source.contentHint = profile.contentHint;
		this.#rebase = new Rebase(clock);
		this.#onRendition = onRendition;
		const track = broadcast.createTrack(Tracks.video, Container.trackInfo({ priority: Catalog.PRIORITY.video }));
		this.#track = track;
		this.#abrTimer = setInterval(() => this.#adapt(), 1000);
		this.#producer = new Container.Legacy.Producer(track, new Container.Legacy.Format("video"));
		void this.#run().catch((err) => {
			if (!this.#closed) console.error("video publisher failed", err);
		});
	}

	async #run() {
		this.#reader = new MediaStreamTrackProcessor<VideoFrame>({ track: this.#source }).readable.getReader();
		let lastKeyframe = Number.NEGATIVE_INFINITY;
		let size = "";

		for (;;) {
			const { value: frame, done } = await this.#reader.read();
			if (done || this.#closed) {
				frame?.close();
				break;
			}
			// Pin the capture→session offset at capture time (before any await), so the
			// advertised timestamps, and so measured latency, include encoding.
			this.#rebase.apply(frame.timestamp);

			// Size the encoder from the frames (H.264 needs even dimensions), and reconfigure
			// if they change, e.g. a shared window being resized.
			const width = frame.displayWidth & ~1;
			const height = frame.displayHeight & ~1;
			if (!this.#encoder || `${width}x${height}` !== size) {
				size = `${width}x${height}`;
				if (this.#encoder?.state === "configured") {
					await this.#encoder.flush().catch(() => {});
					this.#encoder.close();
				}
				this.#config = { ...(await pickCodec(this.#profile, width, height)), bitrate: this.#rate.target };
				this.#encoder = this.#createEncoder(this.#config);
				this.send.bitrate = this.#config.bitrate ?? this.#profile.bitrate;
				this.#forceKeyframe = true;
			}

			// Camera off: the track is disabled and yields black frames; send nothing.
			if (!this.#enabled) {
				frame.close();
				continue;
			}

			// At low bitrates send fewer frames, so each gets enough bits (and the encoder
			// overshoots less): 15 fps under 300 kbps, 10 fps under 200 kbps.
			const keep =
				this.send.bitrate && this.send.bitrate < 200_000 ? 3 : this.send.bitrate && this.send.bitrate < 300_000 ? 2 : 1;
			if (keep > 1 && ++this.#frameCount % keep !== 0 && !this.#forceKeyframe) {
				frame.close();
				continue;
			}

			// Under load, drop frames at the source rather than queueing latency.
			if (this.#encoder.encodeQueueSize > 2) {
				frame.close();
				continue;
			}

			const keyFrame = this.#forceKeyframe || frame.timestamp - lastKeyframe >= this.#profile.keyframeIntervalUs;
			this.#forceKeyframe = false;
			if (keyFrame) lastKeyframe = frame.timestamp;
			this.#encoder.encode(frame, { keyFrame });
			frame.close();
		}
	}

	#createEncoder(config: VideoEncoderConfig): VideoEncoder {
		const encoder = new VideoEncoder({
			output: (chunk, meta) => {
				if (meta?.decoderConfig) {
					this.#onRendition({
						codec: meta.decoderConfig.codec,
						codedWidth: meta.decoderConfig.codedWidth ?? config.width,
						codedHeight: meta.decoderConfig.codedHeight ?? config.height,
						framerate: this.#profile.framerate,
						bitrate: this.#profile.bitrate,
						description: toHex(meta.decoderConfig.description),
						optimizeForLatency: true,
						container: { kind: "legacy" },
					});
				}
				const pts = Time.Micro(this.#rebase.apply(chunk.timestamp));
				this.#producer.encode(chunk as unknown as Container.Legacy.Source, pts, chunk.type === "key");
			},
			error: (err) => console.error("video encoder error", err),
		});
		encoder.configure(config);
		return encoder;
	}

	/** Once a second: adapt the encoder bitrate to the uplink. */
	#adapt() {
		const encoder = this.#encoder;
		const config = this.#config;
		if (!this.#network || !encoder || encoder.state !== "configured" || !config) return;
		const { bandwidth, rtt } = this.#network();
		if (bandwidth && this.#reservation?.handle !== bandwidth) {
			// New connection (or first time): reserve our ceiling on its allocator.
			this.#reservation?.reservation.close();
			this.#reservation = { handle: bandwidth, reservation: bandwidth.reserve(this.#track, this.#profile.bitrate) };
		}
		// undefined = no estimate or nobody subscribed; the controller falls back to RTT.
		const grant = this.#reservation?.reservation.peek();
		this.send.grant = grant;
		this.send.rtt = rtt;
		const target = this.#rate.update({ grant, rtt });
		const current = config.bitrate ?? this.#profile.bitrate;
		// Hysteresis: only reconfigure on a >10% change.
		if (Math.abs(target - current) / current < 0.1) return;
		this.#config = { ...config, bitrate: target };
		encoder.configure(this.#config);
		this.send.bitrate = target;
	}

	/**
	 * Camera on/off. Off disables the capture track (Chrome turns the camera light off),
	 * flushes the encoder and cuts the group, so subscribers see a clean break instead of
	 * a stale frame reading as live. On resumes with a keyframe, opening a new group.
	 */
	setEnabled(enabled: boolean) {
		if (enabled === this.#enabled || this.#closed) return;
		this.#enabled = enabled;
		this.#source.enabled = enabled;
		if (enabled) {
			this.#forceKeyframe = true;
			return;
		}
		const encoder = this.#encoder;
		void (async () => {
			if (encoder?.state === "configured") await encoder.flush().catch(() => {});
			if (!this.#enabled && !this.#closed) this.#producer.cut();
		})();
	}

	close() {
		if (this.#closed) return;
		this.#closed = true;
		clearInterval(this.#abrTimer);
		this.#reservation?.reservation.close();
		void this.#reader?.cancel().catch(() => {});
		if (this.#encoder?.state === "configured") this.#encoder.close();
		this.#producer.close();
	}
}
