/**
 * Audio playout: one AudioContext for the page, one AudioWorklet jitter buffer per peer.
 *
 * Decoded PCM is posted to the worklet, which starts playing once START_MS is buffered and
 * drops back to TARGET_MS when the backlog exceeds MAX_MS, so latency can't creep. This is
 * the same route @moq/watch uses (AudioWorklet → destination); Chrome's tab-wide echo
 * cancellation is expected to cover it (verify with speakers, see docs/notes/moq-api.md).
 */
const SAMPLE_RATE = 48_000;
const START_MS = 60;
const TARGET_MS = 80;
const MAX_MS = 200;

const WORKLET = /* js */ `
class PcmPlayer extends AudioWorkletProcessor {
	constructor() {
		super();
		this.buf = new Float32Array(sampleRate); // 1 s ring
		this.r = 0;
		this.size = 0;
		this.playing = false;
		this.start = Math.round(sampleRate * ${START_MS} / 1000);
		this.target = Math.round(sampleRate * ${TARGET_MS} / 1000);
		this.max = Math.round(sampleRate * ${MAX_MS} / 1000);
		this.underruns = 0;
		this.port.onmessage = (e) => this.push(e.data);
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
				if (this.playing) { this.playing = false; this.underruns++; }
			}
		}
		for (let c = 1; c < out.length; c++) out[c].set(ch0);
		return true;
	}
}
registerProcessor("pcm-player", PcmPlayer);
`;

export interface PeerAudio {
	/** Mono 48 kHz PCM. */
	push(samples: Float32Array): void;
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
		return {
			push: (samples) => node.port.postMessage(samples, [samples.buffer]),
			close: () => node.disconnect(),
		};
	}

	close() {
		void this.context.close();
	}
}
