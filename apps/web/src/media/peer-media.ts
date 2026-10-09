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
	/** Video payload received over the last second. */
	videoKbps: number;
	/** Video groups skipped (too late or lost) since subscribing: the relay/consumer shedding load. */
	videoSkips: number;
	/** Capture → decode for audio, using the peer's catalog clock. */
	audioLatencyMs?: number;
	/** Jitter buffer counters since subscribing. */
	audioUnderruns: number;
	audioDroppedMs: number;
	/** The adaptive jitter buffer's current playout delay. */
	audioBufferMs: number;
	/** Video paused because it fell too far behind live (audio-only fallback). */
	videoPaused: boolean;
}

type Root = Catalog.Root;
type Clock = { wall: number; timescale: number };

/** Local staleness budgets: skip groups older than this rather than fall behind live. */
const VIDEO_MAX_AGE = 500;

/**
 * Audio-only fallback. Skipping happens per group, so a starved video stream can sit up to a
 * GoP behind live. If it stays more than LAG_MS behind for LAG_SECONDS, drop the video
 * subscription (freeing the bandwidth for audio) and retry later, backing off each time.
 */
const LAG_MS = 1000;
/** Long enough for the sender's rate controller (1 s ticks) to react first. */
const LAG_SECONDS = 5;
const RETRY_MS = { first: 15_000, max: 60_000 };
/** A resumed stream that stays healthy this long resets the backoff. */
const HEALTHY_RESET_MS = 30_000;
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
	#stats: PeerStats = {
		fps: 0,
		audio: false,
		videoKbps: 0,
		videoSkips: 0,
		audioUnderruns: 0,
		audioDroppedMs: 0,
		audioBufferMs: 0,
		videoPaused: false,
	};
	/** The video rendition we want, and whether its pipeline is running or paused. */
	#videoWant: { broadcast: Moq.Broadcast.Consumer; name: string; config: Catalog.VideoConfig } | undefined;
	#lagSeconds = 0;
	#pausedUntil = 0;
	#retryMs = RETRY_MS.first;
	#resumedAt = 0;
	#videoBytes = 0;
	#videoSkips = 0;
	#audioLatency: number | undefined;
	#peerAudio: PeerAudio | undefined;

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
			const playout = this.#peerAudio?.stats();
			this.#checkLag(Math.round((this.#videoBytes * 8) / 1000));
			this.#stats = {
				...this.#stats,
				fps: this.#frames,
				videoLatencyMs: this.#video ? this.#latency : undefined,
				audioLevelDb,
				videoKbps: Math.round((this.#videoBytes * 8) / 1000),
				videoSkips: this.#videoSkips,
				audioLatencyMs: this.#audioLatency,
				audioUnderruns: playout?.underruns ?? 0,
				audioDroppedMs: playout?.droppedMs ?? 0,
				audioBufferMs: playout?.startMs ?? 0,
			};
			this.#frames = 0;
			this.#videoBytes = 0;
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
		if (videoKey !== (this.#videoKey ?? "")) {
			this.#videoKey = videoKey;
			this.#videoWant = video ? { broadcast, name: video[0], config: video[1] } : undefined;
			this.#stats = { ...this.#stats, codec: video?.[1].codec };
			this.#video?.stop();
			this.#video = undefined;
			if (!this.#stats.videoPaused) this.#startVideo();
		}

		const audio = firstRendition<Catalog.AudioConfig>(root.audio);
		const audioKey = audio ? JSON.stringify(audio) : "";
		if (audioKey !== (this.#audio?.key ?? "")) {
			this.#audio?.stop();
			this.#audio = audio ? { key: audioKey, stop: this.#runAudio(broadcast, audio[0], audio[1]) } : undefined;
			this.#stats = { ...this.#stats, audio: !!audio };
		}
	}

	#videoKey: string | undefined;

	#startVideo() {
		const want = this.#videoWant;
		if (!want) return;
		this.#latency = undefined;
		this.#video = { key: this.#videoKey ?? "", stop: this.#runVideo(want.broadcast, want.name, want.config) };
	}

	/** Called once a second: pause video that's persistently behind, resume it when the retry is due. */
	#checkLag(kbps: number) {
		const now = performance.now();
		if (this.#stats.videoPaused) {
			if (now >= this.#pausedUntil) {
				this.#stats = { ...this.#stats, videoPaused: false };
				this.#lagSeconds = 0;
				this.#resumedAt = now;
				this.#startVideo();
			}
			return;
		}
		if (!this.#video) return;
		// Behind: frames render late, or bytes arrive but nothing renders (waiting on a stalled GoP).
		const behind = (this.#latency !== undefined && this.#latency > LAG_MS) || (this.#frames === 0 && kbps > 0);
		this.#lagSeconds = behind ? this.#lagSeconds + 1 : 0;
		if (!behind && this.#resumedAt && now - this.#resumedAt > HEALTHY_RESET_MS) {
			this.#retryMs = RETRY_MS.first;
			this.#resumedAt = 0;
		}
		if (this.#lagSeconds >= LAG_SECONDS) {
			this.#video.stop();
			this.#video = undefined;
			this.#latency = undefined;
			this.#pausedUntil = now + this.#retryMs;
			this.#retryMs = Math.min(this.#retryMs * 2, RETRY_MS.max);
			this.#stats = { ...this.#stats, videoPaused: true };
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
		let started = false;

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
				this.#videoBytes += frame.payload.byteLength;
				// After a skipped group or a decoder reset, resume only at a keyframe.
				if (!next.continuous) {
					if (started) this.#videoSkips++;
					needKeyframe = true;
				}
				started = true;
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
			this.#peerAudio = out;
			for (;;) {
				const next = await consumer.next();
				if (!next || stopped) break;
				if (!next.frame || decoder.state !== "configured") continue;
				// Measure on arrival: AudioDecoder output timestamps are derived from the first
				// chunk plus samples decoded, so after a skip they run ahead of the real ones.
				if (this.#clock) this.#audioLatency = Math.round(Date.now() - wallTimeMs(this.#clock, next.frame.timestamp));
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
