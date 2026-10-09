/** RMS above this (≈ −42 dBFS) counts as speech; Chrome's noise suppression keeps silence well below. */
const THRESHOLD = 0.008;
/** Stay "speaking" this long after the last loud chunk, so the highlight doesn't flicker between words. */
const HOLD_MS = 400;

export function rms(samples: Float32Array): number {
	let sum = 0;
	for (const s of samples) sum += s * s;
	return Math.sqrt(sum / (samples.length || 1));
}

/** Turns a stream of audio levels into a debounced speaking flag. */
export class SpeakingDetector {
	#lastLoud = Number.NEGATIVE_INFINITY;

	push(level: number, now = performance.now()) {
		if (level >= THRESHOLD) this.#lastLoud = now;
	}

	speaking(now = performance.now()): boolean {
		return now - this.#lastLoud < HOLD_MS;
	}
}

/** Speaking detection for the local microphone, via an AnalyserNode (no encoding involved). */
export class LocalSpeaking {
	readonly #analyser: AnalyserNode;
	readonly #source: MediaStreamAudioSourceNode;
	readonly #buf: Float32Array<ArrayBuffer>;
	readonly #detector = new SpeakingDetector();

	constructor(context: AudioContext, track: MediaStreamTrack) {
		this.#source = context.createMediaStreamSource(new MediaStream([track]));
		this.#analyser = context.createAnalyser();
		this.#analyser.fftSize = 1024;
		this.#buf = new Float32Array(this.#analyser.fftSize);
		// Analyser only: not connected to the destination, so we never hear ourselves.
		this.#source.connect(this.#analyser);
	}

	speaking(): boolean {
		this.#analyser.getFloatTimeDomainData(this.#buf);
		this.#detector.push(rms(this.#buf));
		return this.#detector.speaking();
	}

	close() {
		this.#source.disconnect();
	}
}
