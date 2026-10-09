/**
 * Audio playout: one AudioContext for the page, one AudioWorklet jitter buffer per peer.
 *
 * Decoded PCM is posted to the worklet, an adaptive jitter buffer: it starts playing once
 * `start` ms are buffered, and skips back to `start + 20` ms when the backlog exceeds
 * `start + 140` ms, so latency can't creep. Each underrun (audible gap: on a lossy link, a
 * retransmission takes about an RTT) raises `start` by 20 ms up to MAX_START_MS; 10 s without
 * one lowers it 10 ms back toward MIN_START_MS. This is
 * the same route @moq/watch uses (AudioWorklet → destination); Chrome's tab-wide echo
 * cancellation is expected to cover it (verify with speakers, see docs/notes/moq-api.md).
 */
const SAMPLE_RATE = 48_000;
const MIN_START_MS = 60;
const MAX_START_MS = 200;

const WORKLET = /* js */ `
class PcmPlayer extends AudioWorkletProcessor {
	constructor() {
		super();
		this.buf = new Float32Array(sampleRate); // 1 s ring
		this.r = 0;
		this.size = 0;
		this.playing = false;
		this.ms = sampleRate / 1000;
		this.minStart = ${MIN_START_MS} * this.ms;
		this.maxStart = ${MAX_START_MS} * this.ms;
		this.setStart(this.minStart);
		this.calmFrames = 0;
		this.underruns = 0;
		this.dropped = 0;
		this.frames = 0;
		this.port.onmessage = (e) => this.push(e.data);
	}
	setStart(start) {
		this.start = Math.round(start);
		this.target = this.start + 20 * this.ms;
		this.max = this.start + 140 * this.ms;
	}
	push(samples) {
		const len = this.buf.length;
		for (let i = 0; i < samples.length; i++) {
			this.buf[(this.r + this.size) % len] = samples[i];
			if (this.size < len) this.size++;
			else this.r = (this.r + 1) % len;
		}
		if (this.size > this.max) {
			const skip = this.size - this.target;
			this.dropped += skip;
			this.r = (this.r + skip) % len;
			this.size -= skip;
		}
	}
	process(_inputs, outputs) {
		const out = outputs[0];
		const ch0 = out[0];
		if (!this.playing && this.size >= this.start) this.playing = true;
		for (let i = 0; i < ch0.length; i++) {
			if (this.playing && this.size > 0) {
				ch0[i] = this.buf[this.r];
				this.r = (this.r + 1) % this.buf.length;
				this.size--;
			} else {
				ch0[i] = 0;
				if (this.playing) {
					this.playing = false;
					this.underruns++;
					this.calmFrames = 0;
					this.setStart(Math.min(this.start + 20 * this.ms, this.maxStart));
				}
			}
		}
		for (let c = 1; c < out.length; c++) out[c].set(ch0);
		// 10 s (in 128-sample render quanta) without an underrun: relax toward the minimum.
		if (++this.calmFrames >= 10 * sampleRate / 128) {
			this.calmFrames = 0;
			this.setStart(Math.max(this.start - 10 * this.ms, this.minStart));
		}
		// Report counters ~4×/s: underruns (ran dry), ms of audio skipped to cap latency, buffer depth.
		if (++this.frames % Math.round(sampleRate / 128 / 4) === 0) {
			this.port.postMessage({ underruns: this.underruns, droppedMs: Math.round(this.dropped * 1000 / sampleRate), bufferedMs: Math.round(this.size * 1000 / sampleRate), startMs: Math.round(this.start / this.ms) });
		}
		return true;
	}
}
registerProcessor("pcm-player", PcmPlayer);
`;

export interface PlayoutStats {
	/** Times the jitter buffer ran dry (audible gaps). */
	underruns: number;
	/** Audio skipped to cap latency when the buffer grew past MAX_MS. */
	droppedMs: number;
	bufferedMs: number;
	/** Current adaptive playout delay. */
	startMs: number;
}

export interface PeerAudio {
	/** Mono 48 kHz PCM. */
	push(samples: Float32Array): void;
	/** Latest counters from the worklet (cumulative since this peer was added). */
	stats(): PlayoutStats;
	close(): void;
}

export class AudioOut {
	readonly context: AudioContext;
	readonly #ready: Promise<void>;

	/** Create inside a user gesture (e.g. the Join click) so playback is allowed. */
	constructor() {
		this.context = new AudioContext({ latencyHint: "interactive", sampleRate: SAMPLE_RATE });
		const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
		this.#ready = this.context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
		void this.context.resume();
	}

	async addPeer(): Promise<PeerAudio> {
		await this.#ready;
		const node = new AudioWorkletNode(this.context, "pcm-player", { outputChannelCount: [1] });
		node.connect(this.context.destination);
		let stats: PlayoutStats = { underruns: 0, droppedMs: 0, bufferedMs: 0, startMs: MIN_START_MS };
		node.port.onmessage = (e) => {
			stats = e.data as PlayoutStats;
		};
		return {
			push: (samples) => node.port.postMessage(samples, [samples.buffer]),
			stats: () => stats,
			close: () => node.disconnect(),
		};
	}

	close() {
		void this.context.close();
	}
}
