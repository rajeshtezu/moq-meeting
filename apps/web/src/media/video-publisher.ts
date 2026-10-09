import { Catalog, Container } from "@moq/hang";
import type * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { Tracks } from "@moq-meeting/shared";
import { toHex, type VideoRendition } from "./catalog";
import { type MediaClock, Rebase } from "./clock";

export interface VideoProfile {
	/** Capture constraints; the encoder is sized from the actual frames. */
	width: number;
	height: number;
	framerate: number;
	bitrate: number;
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
	#enabled = true;
	#forceKeyframe = false;
	#closed = false;

	constructor(
		source: MediaStreamTrack,
		broadcast: Moq.Broadcast.Producer,
		clock: MediaClock,
		onRendition: (r: VideoRendition) => void,
		profile: VideoProfile = CAMERA,
	) {
		this.#source = source;
		this.#profile = profile;
		if (profile.contentHint) source.contentHint = profile.contentHint;
		this.#rebase = new Rebase(clock);
		this.#onRendition = onRendition;
		const track = broadcast.createTrack(Tracks.video, Container.trackInfo({ priority: Catalog.PRIORITY.video }));
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
				this.#encoder = this.#createEncoder(await pickCodec(this.#profile, width, height));
				this.#forceKeyframe = true;
			}

			// Camera off: the track is disabled and yields black frames; send nothing.
			if (!this.#enabled) {
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
		void this.#reader?.cancel().catch(() => {});
		if (this.#encoder?.state === "configured") this.#encoder.close();
		this.#producer.close();
	}
}
