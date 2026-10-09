import { Catalog, Container } from "@moq/hang";
import type * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { Tracks } from "@moq-meeting/shared";
import { type AudioRendition, toHex } from "./catalog";
import { type MediaClock, Rebase } from "./clock";

export const AUDIO = {
	codec: "opus",
	bitrate: 32_000,
	/** 20 ms Opus frames: the usual real-time trade-off between overhead and latency. */
	frameDurationUs: 20_000,
	/** ~1 s of audio per MoQ group, so a stalled group costs at most a second. */
	groupDurationUs: 1_000_000,
} as const;

/** Microphone track → AudioEncoder (Opus) → hang legacy container on the `audio` track. */
export class AudioPublisher {
	readonly #producer: Container.Legacy.Producer;
	readonly #source: MediaStreamTrack;
	readonly #rebase: Rebase;
	readonly #onRendition: (r: AudioRendition) => void;
	#reader: ReadableStreamDefaultReader<AudioData> | undefined;
	#encoder: AudioEncoder | undefined;
	#groupStart = Number.NEGATIVE_INFINITY;
	#closed = false;

	constructor(
		source: MediaStreamTrack,
		broadcast: Moq.Broadcast.Producer,
		clock: MediaClock,
		onRendition: (r: AudioRendition) => void,
	) {
		this.#source = source;
		this.#rebase = new Rebase(clock);
		this.#onRendition = onRendition;
		const track = broadcast.createTrack(Tracks.audio, Container.trackInfo({ priority: Catalog.PRIORITY.audio }));
		this.#producer = new Container.Legacy.Producer(track, new Container.Legacy.Format("audio"));
		void this.#run().catch((err) => {
			if (!this.#closed) console.error("audio publisher failed", err);
		});
	}

	async #run() {
		this.#reader = new MediaStreamTrackProcessor<AudioData>({ track: this.#source }).readable.getReader();
		for (;;) {
			const { value: data, done } = await this.#reader.read();
			if (done || this.#closed) {
				data?.close();
				break;
			}
			// Pin the capture→session offset at capture time, before any await.
			this.#rebase.apply(data.timestamp);
			this.#encoder ??= await this.#createEncoder(data.sampleRate, data.numberOfChannels);
			this.#encoder.encode(data);
			data.close();
		}
	}

	async #createEncoder(sampleRate: number, numberOfChannels: number): Promise<AudioEncoder> {
		const config: AudioEncoderConfig = {
			codec: AUDIO.codec,
			sampleRate,
			numberOfChannels,
			bitrate: AUDIO.bitrate,
			opus: { frameDuration: AUDIO.frameDurationUs },
		};
		const { supported } = await AudioEncoder.isConfigSupported(config);
		if (!supported) throw new Error(`opus encoder unsupported at ${sampleRate} Hz x${numberOfChannels}`);

		const encoder = new AudioEncoder({
			output: (chunk, meta) => {
				if (meta?.decoderConfig) {
					this.#onRendition({
						codec: meta.decoderConfig.codec,
						sampleRate: meta.decoderConfig.sampleRate,
						numberOfChannels: meta.decoderConfig.numberOfChannels,
						bitrate: AUDIO.bitrate,
						description: toHex(meta.decoderConfig.description),
						container: { kind: "legacy" },
					});
				}
				const pts = this.#rebase.apply(chunk.timestamp);
				const newGroup = pts - this.#groupStart >= AUDIO.groupDurationUs;
				if (newGroup) this.#groupStart = pts;
				this.#producer.encode(chunk as unknown as Container.Legacy.Source, Time.Micro(pts), newGroup);
			},
			error: (err) => console.error("audio encoder error", err),
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
