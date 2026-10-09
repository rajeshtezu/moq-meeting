import { Catalog, Container } from "@moq/hang";
import type * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { Tracks } from "@moq-meeting/shared";
import { toHex, type VideoRendition } from "./catalog";
import { type MediaClock, Rebase } from "./clock";

/** Phase 1 encoding ladder: one 360p rendition. */
export const VIDEO = {
	width: 640,
	height: 360,
	framerate: 30,
	bitrate: 800_000,
	/** A keyframe (and so a new group) every 2 s bounds join time and loss recovery. */
	keyframeIntervalUs: 2_000_000,
} as const;

/** H.264 baseline first (hardware-friendly), VP8 as the fallback (intake Q3). */
const CODECS: Pick<VideoEncoderConfig, "codec" | "avc">[] = [
	{ codec: "avc1.42E01F", avc: { format: "annexb" } },
	{ codec: "vp8" },
];

async function pickCodec(width: number, height: number): Promise<VideoEncoderConfig> {
	for (const candidate of CODECS) {
		const config: VideoEncoderConfig = {
			...candidate,
			width,
			height,
			bitrate: VIDEO.bitrate,
			framerate: VIDEO.framerate,
			latencyMode: "realtime",
		};
		const { supported } = await VideoEncoder.isConfigSupported(config);
		if (supported) return config;
	}
	throw new Error("no supported video encoder (tried H.264, VP8)");
}

/**
 * Camera track → VideoEncoder → hang legacy container on the `video` track.
 * `Legacy.Producer` starts a new MoQ group at every keyframe, so each group is one GoP.
 */
export class VideoPublisher {
	readonly #producer: Container.Legacy.Producer;
	readonly #source: MediaStreamTrack;
	readonly #rebase: Rebase;
	readonly #onRendition: (r: VideoRendition) => void;
	#reader: ReadableStreamDefaultReader<VideoFrame> | undefined;
	#encoder: VideoEncoder | undefined;
	#closed = false;

	constructor(
		source: MediaStreamTrack,
		broadcast: Moq.Broadcast.Producer,
		clock: MediaClock,
		onRendition: (r: VideoRendition) => void,
	) {
		this.#source = source;
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
		let pendingConfig: VideoEncoderConfig | undefined;

		for (;;) {
			const { value: frame, done } = await this.#reader.read();
			if (done || this.#closed) {
				frame?.close();
				break;
			}
			// Pin the capture→session offset at capture time (before any await), so the
			// advertised timestamps, and so measured latency, include encoding.
			this.#rebase.apply(frame.timestamp);

			if (!this.#encoder) {
				// Size the encoder from the first frame; H.264 needs even dimensions.
				const width = frame.displayWidth & ~1;
				const height = frame.displayHeight & ~1;
				pendingConfig = await pickCodec(width, height);
				this.#encoder = this.#createEncoder(pendingConfig);
			}

			// Under load, drop frames at the source rather than queueing latency.
			if (this.#encoder.encodeQueueSize > 2) {
				frame.close();
				continue;
			}

			const keyFrame = frame.timestamp - lastKeyframe >= VIDEO.keyframeIntervalUs;
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
						framerate: VIDEO.framerate,
						bitrate: VIDEO.bitrate,
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

	close() {
		if (this.#closed) return;
		this.#closed = true;
		void this.#reader?.cancel().catch(() => {});
		if (this.#encoder?.state === "configured") this.#encoder.close();
		this.#producer.close();
	}
}
