import { Catalog, Container } from "@moq/hang";
import type * as Moq from "@moq/net";
import { Time } from "@moq/net";
import type { AudioOut, PeerAudio } from "./audio-out";
import { fromHex } from "./catalog";
import { wallTimeMs } from "./clock";
import { rms, SpeakingDetector } from "./speaking";

export interface PeerStats {
	fps: number;
	/** Capture → render, using the peer's catalog clock. Assumes synced wall clocks. */
	videoLatencyMs?: number;
	width?: number;
	height?: number;
	codec?: string;
	audio: boolean;
	/** Peak RMS of decoded audio over the last second, in dBFS; undefined if none arrived. */
	audioLevelDb?: number;
}

type Root = Catalog.Root;
type Clock = { wall: number; timescale: number };

/** Local staleness budgets: skip groups older than this rather than fall behind live. */
const VIDEO_MAX_AGE = 500;
const AUDIO_MAX_AGE = Time.Milli(300);

function firstRendition<T>(section: unknown): [string, T] | undefined {
	if (!section || typeof section !== "object" || !("renditions" in section)) return undefined;
	const entries = Object.entries((section as { renditions: Record<string, T> }).renditions);
	return entries[0];
}

/**
 * Subscribes to one remote participant's broadcast: follows `catalog.json`, then decodes the
 * `video` rendition onto a canvas and plays the `audio` rendition through AudioOut.
 */
export class PeerMedia {
	readonly #canvas: HTMLCanvasElement;
	readonly #audioOut: AudioOut;
	readonly #onStats: (s: PeerStats) => void;
	readonly #abort = new AbortController();
	readonly #videoMaxAge: Time.Milli;
	#video: { key: string; stop: () => void } | undefined;
	#audio: { key: string; stop: () => void } | undefined;
	#clock: Clock | undefined;
	#frames = 0;
	#latency: number | undefined;
	#audioPeak = 0;
	readonly #speaking = new SpeakingDetector();
	#statsTimer: ReturnType<typeof setInterval>;
	#stats: PeerStats = { fps: 0, audio: false };

	constructor(
		request: Moq.Origin.Requesting,
		canvas: HTMLCanvasElement,
		audioOut: AudioOut,
		onStats: (s: PeerStats) => void,
		/** Screen shares send big keyframes at a low rate, so allow them more time. */
		options: { videoMaxAgeMs?: number } = {},
	) {
		this.#videoMaxAge = Time.Milli(options.videoMaxAgeMs ?? VIDEO_MAX_AGE);
		this.#canvas = canvas;
		this.#audioOut = audioOut;
		this.#onStats = onStats;
		this.#statsTimer = setInterval(() => {
			const audioLevelDb = this.#audioPeak > 0 ? Math.round(20 * Math.log10(this.#audioPeak)) : undefined;
			this.#stats = { ...this.#stats, fps: this.#frames, videoLatencyMs: this.#latency, audioLevelDb };
			this.#frames = 0;
			this.#audioPeak = 0;
			this.#onStats(this.#stats);
		}, 1000);
		void this.#run(request).catch((err) => {
			if (!this.#abort.signal.aborted) console.warn("peer media stopped", err);
		});
	}

	async #run(request: Moq.Origin.Requesting) {
		let broadcast = request.active.peek();
		while (!broadcast) {
			await request.active.changed();
			if (this.#abort.signal.aborted) return;
			broadcast = request.active.peek();
		}
		for await (const root of Catalog.watch(broadcast)) {
			if (this.#abort.signal.aborted) break;
			this.#apply(broadcast, root);
		}
	}

	#apply(broadcast: Moq.Broadcast.Consumer, root: Root) {
		this.#clock = root.clock as Clock | undefined;

		const video = firstRendition<Catalog.VideoConfig>(root.video);
		const videoKey = video ? JSON.stringify(video) : "";
		if (videoKey !== (this.#video?.key ?? "")) {
			this.#video?.stop();
			this.#video = video ? { key: videoKey, stop: this.#runVideo(broadcast, video[0], video[1]) } : undefined;
			this.#stats = { ...this.#stats, codec: video?.[1].codec };
		}

		const audio = firstRendition<Catalog.AudioConfig>(root.audio);
		const audioKey = audio ? JSON.stringify(audio) : "";
		if (audioKey !== (this.#audio?.key ?? "")) {
			this.#audio?.stop();
			this.#audio = audio ? { key: audioKey, stop: this.#runAudio(broadcast, audio[0], audio[1]) } : undefined;
			this.#stats = { ...this.#stats, audio: !!audio };
		}
	}

	#runVideo(broadcast: Moq.Broadcast.Consumer, name: string, config: Catalog.VideoConfig): () => void {
		const track = broadcast.track(name).subscribe({ priority: Catalog.PRIORITY.video, maxAge: this.#videoMaxAge });
		const consumer = new Container.Consumer(track, {
			format: new Container.Legacy.Format(config),
			maxAge: this.#videoMaxAge,
		});
		const ctx = this.#canvas.getContext("2d");
		let stopped = false;
		let needKeyframe = true;

		const makeDecoder = (): VideoDecoder => {
			const d = new VideoDecoder({
				output: (frame) => {
					if (stopped || !ctx) return frame.close();
					if (this.#canvas.width !== frame.displayWidth) this.#canvas.width = frame.displayWidth;
					if (this.#canvas.height !== frame.displayHeight) this.#canvas.height = frame.displayHeight;
					ctx.drawImage(frame, 0, 0);
					this.#frames++;
					if (this.#clock) this.#latency = Math.round(Date.now() - wallTimeMs(this.#clock, frame.timestamp));
					this.#stats = { ...this.#stats, width: frame.displayWidth, height: frame.displayHeight };
					frame.close();
				},
				error: (err) => {
					console.warn("video decoder error; waiting for next keyframe", err);
					needKeyframe = true;
					decoder = makeDecoder();
				},
			});
			d.configure({
				codec: config.codec,
				codedWidth: config.codedWidth,
				codedHeight: config.codedHeight,
				description: fromHex(config.description),
				optimizeForLatency: true,
			});
			return d;
		};
		let decoder = makeDecoder();

		void (async () => {
			for (;;) {
				const next = await consumer.next();
				if (!next || stopped) break;
				const { frame } = next;
				if (!frame) continue;
				// After a skipped group or a decoder reset, resume only at a keyframe.
				if (!next.continuous) needKeyframe = true;
				if (needKeyframe && !frame.keyframe) continue;
				needKeyframe = false;
				if (decoder.state !== "configured") continue;
				decoder.decode(
					new EncodedVideoChunk({
						type: frame.keyframe ? "key" : "delta",
						timestamp: frame.timestamp,
						data: frame.payload,
					}),
				);
			}
		})().catch((err) => !stopped && console.warn("video track ended", err));

		return () => {
			stopped = true;
			consumer.close();
			track.close();
			if (decoder.state !== "closed") decoder.close();
		};
	}

	#runAudio(broadcast: Moq.Broadcast.Consumer, name: string, config: Catalog.AudioConfig): () => void {
		const track = broadcast.track(name).subscribe({ priority: Catalog.PRIORITY.audio, maxAge: AUDIO_MAX_AGE });
		const consumer = new Container.Consumer(track, {
			format: new Container.Legacy.Format(config),
			maxAge: AUDIO_MAX_AGE,
		});
		let stopped = false;
		let out: PeerAudio | undefined;

		const decoder = new AudioDecoder({
			output: (data) => {
				if (stopped || !out) return data.close();
				const pcm = downmix(data);
				const level = rms(pcm);
				this.#audioPeak = Math.max(this.#audioPeak, level);
				this.#speaking.push(level);
				out.push(pcm);
				data.close();
			},
			error: (err) => console.warn("audio decoder error", err),
		});
		decoder.configure({
			codec: config.codec,
			sampleRate: config.sampleRate,
			numberOfChannels: config.numberOfChannels,
			description: fromHex(config.description),
		});

		void (async () => {
			out = await this.#audioOut.addPeer();
			for (;;) {
				const next = await consumer.next();
				if (!next || stopped) break;
				if (!next.frame || decoder.state !== "configured") continue;
				decoder.decode(
					new EncodedAudioChunk({ type: "key", timestamp: next.frame.timestamp, data: next.frame.payload }),
				);
			}
		})().catch((err) => !stopped && console.warn("audio track ended", err));

		return () => {
			stopped = true;
			consumer.close();
			track.close();
			out?.close();
			if (decoder.state !== "closed") decoder.close();
		};
	}

	/** Whether this peer is audibly speaking right now (debounced). */
	get speaking(): boolean {
		return this.#speaking.speaking();
	}

	close() {
		this.#abort.abort();
		clearInterval(this.#statsTimer);
		this.#video?.stop();
		this.#audio?.stop();
	}
}

/** Decoded Opus → mono Float32 for the jitter buffer (the context runs at 48 kHz, like Opus). */
function downmix(data: AudioData): Float32Array {
	const frames = data.numberOfFrames;
	const out = new Float32Array(frames);
	const tmp = new Float32Array(frames);
	for (let c = 0; c < data.numberOfChannels; c++) {
		data.copyTo(tmp, { planeIndex: c, format: "f32-planar" });
		for (let i = 0; i < frames; i++) out[i] = (out[i] ?? 0) + (tmp[i] ?? 0) / data.numberOfChannels;
	}
	return out;
}
