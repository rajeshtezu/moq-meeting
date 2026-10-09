/**
 * Read raw frames from a MediaStreamTrack as a ReadableStream, with or without
 * `MediaStreamTrackProcessor` (Chrome-only today; Firefox and Safari lack it).
 *
 * Fallbacks:
 * - video: a hidden <video> element, grabbing each presented frame with
 *   `requestVideoFrameCallback` (or a worker-timed tick where that's missing or throttled)
 *   and wrapping it in `new VideoFrame(video)`.
 * - audio: an AudioWorklet that copies the microphone's samples to the main thread, batched
 *   into 20 ms mono `AudioData` chunks at 48 kHz (resampled if the context runs at another
 *   rate, since Opus encoders want 48 kHz).
 *
 * `?mstp=0` forces the fallbacks, to test them in Chrome.
 */

function processorAvailable(): boolean {
	if (typeof MediaStreamTrackProcessor === "undefined") return false;
	try {
		return new URLSearchParams(globalThis.location?.search ?? "").get("mstp") !== "0";
	} catch {
		return true;
	}
}

export function videoFrames(track: MediaStreamTrack, fps: number): ReadableStream<VideoFrame> {
	if (processorAvailable()) return new MediaStreamTrackProcessor<VideoFrame>({ track }).readable;

	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.srcObject = new MediaStream([track]);
	let stopped = false;
	let ticker: Worker | undefined;

	return new ReadableStream<VideoFrame>({
		start(controller) {
			const grab = () => {
				if (stopped || video.readyState < 2 || !video.videoWidth) return;
				try {
					controller.enqueue(new VideoFrame(video, { timestamp: Math.round(performance.now() * 1000) }));
				} catch {
					// A frame that can't be captured yet (e.g. mid-resize): skip it.
				}
			};
			const onFrame = () => {
				grab();
				if (!stopped) video.requestVideoFrameCallback(onFrame);
			};
			void video.play().then(() => {
				if ("requestVideoFrameCallback" in video && document.visibilityState === "visible") {
					video.requestVideoFrameCallback(onFrame);
				}
				// rVFC is throttled in background tabs (and missing in some browsers): also tick
				// from a worker, skipping if rVFC already delivered this frame recently.
				let last = 0;
				ticker = new Worker(
					URL.createObjectURL(
						new Blob([`setInterval(() => postMessage(0), ${1000 / fps})`], { type: "text/javascript" }),
					),
				);
				ticker.onmessage = () => {
					const now = performance.now();
					if (document.visibilityState === "visible" && "requestVideoFrameCallback" in video) return;
					if (now - last < 1000 / fps / 2) return;
					last = now;
					grab();
				};
			});
		},
		cancel() {
			stopped = true;
			ticker?.terminate();
			video.pause();
			video.srcObject = null;
		},
	});
}

const CAPTURE_WORKLET = /* js */ `
class Capture extends AudioWorkletProcessor {
	process(inputs) {
		const ch = inputs[0]?.[0];
		if (ch) this.port.postMessage(ch.slice(0));
		return true;
	}
}
registerProcessor("capture", Capture);
`;

const OPUS_RATE = 48_000;
const CHUNK_FRAMES = 960; // 20 ms at 48 kHz

export function audioFrames(track: MediaStreamTrack): ReadableStream<AudioData> {
	if (processorAvailable()) return new MediaStreamTrackProcessor<AudioData>({ track }).readable;

	let context: AudioContext | undefined;
	let source: MediaStreamAudioSourceNode | undefined;
	let node: AudioWorkletNode | undefined;

	return new ReadableStream<AudioData>({
		async start(controller) {
			// Default rate: some browsers refuse a MediaStream source at a different rate.
			context = new AudioContext();
			const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
			await context.audioWorklet.addModule(url);
			URL.revokeObjectURL(url);
			source = context.createMediaStreamSource(new MediaStream([track]));
			// One (silent) output wired to the destination: Firefox only runs worklets the graph
			// pulls on, and a node with no outputs never gets `process()` calls there.
			node = new AudioWorkletNode(context, "capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
			source.connect(node);
			node.connect(context.destination);
			resumeWhenAllowed(context, "capture");

			const ratio = OPUS_RATE / context.sampleRate;
			const pending = new Float32Array(CHUNK_FRAMES);
			let filled = 0;
			let produced = 0; // samples at 48 kHz, for timestamps
			const start = performance.now() * 1000;
			let carry = 0; // fractional resampling position

			let prev = 0;
			node.port.onmessage = (e) => {
				const input = e.data as Float32Array;
				// Linear resample to 48 kHz (a no-op copy when the context already runs at 48 kHz).
				for (let pos = carry; pos < input.length; pos += 1 / ratio) {
					const i = Math.floor(pos);
					const frac = pos - i;
					const a = i === 0 ? prev : (input[i - 1] ?? 0);
					const b = input[i] ?? 0;
					pending[filled++] = ratio === 1 ? b : a + (b - a) * frac;
					if (filled === CHUNK_FRAMES) {
						controller.enqueue(
							new AudioData({
								format: "f32-planar",
								sampleRate: OPUS_RATE,
								numberOfFrames: CHUNK_FRAMES,
								numberOfChannels: 1,
								timestamp: Math.round(start + (produced / OPUS_RATE) * 1_000_000),
								data: pending.slice(),
							}),
						);
						produced += CHUNK_FRAMES;
						filled = 0;
					}
					carry = pos + 1 / ratio - input.length;
				}
				prev = input[input.length - 1] ?? 0;
			};
		},
		cancel() {
			source?.disconnect();
			node?.disconnect();
			void context?.close();
		},
	});
}

/**
 * Autoplay policy: without a user gesture an AudioContext stays suspended, and in Firefox
 * `resume()` then never settles, so never await it. Ask now, and again on the next interaction.
 */
export function resumeWhenAllowed(context: AudioContext, label: string) {
	void context.resume().catch(() => {});
	setTimeout(() => {
		if (context.state === "running" || context.state === "closed") return;
		console.warn(`${label} AudioContext is ${context.state} (needs a user gesture)`);
		const resume = () => void context.resume().catch(() => {});
		window.addEventListener("pointerdown", resume, { once: true });
		window.addEventListener("keydown", resume, { once: true });
	}, 500);
}
