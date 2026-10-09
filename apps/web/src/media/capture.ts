import { CAMERA, SCREEN } from "./video-publisher";

export type SourceKind = "camera" | "test";

/**
 * Local media. "camera" is the real mic and camera, with echo cancellation on. "test" is a
 * synthetic pattern and tone for machines without a camera, and for automated checks.
 */
export async function captureLocal(
	kind: SourceKind,
	label: string,
): Promise<{ stream: MediaStream; stop: () => void }> {
	if (kind === "camera") {
		const stream = await navigator.mediaDevices.getUserMedia({
			video: {
				width: { ideal: CAMERA.width },
				height: { ideal: CAMERA.height },
				frameRate: { ideal: CAMERA.framerate },
			},
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
		});
		return { stream, stop: () => stopAll(stream) };
	}
	return testSource(label);
}

/**
 * Screen share. "camera" sources use the real `getDisplayMedia` picker (capped at 1080p15 so
 * the encoder needn't scale); "test" sources use a synthetic slide. `onEnded` fires when the
 * user stops sharing from the browser's own UI.
 */
export async function captureScreen(
	kind: SourceKind,
	label: string,
	onEnded: () => void,
): Promise<{ stream: MediaStream; stop: () => void }> {
	const capture =
		kind === "camera"
			? await navigator.mediaDevices
					.getDisplayMedia({
						video: {
							width: { max: SCREEN.width },
							height: { max: SCREEN.height },
							frameRate: { max: SCREEN.framerate },
						},
						audio: false,
					})
					.then((stream) => ({ stream, stop: () => stopAll(stream) }))
			: slideSource(label);
	capture.stream.getVideoTracks()[0]?.addEventListener("ended", onEnded, { once: true });
	return capture;
}

function stopAll(stream: MediaStream) {
	for (const t of stream.getTracks()) t.stop();
}

/** Draw `draw` into a canvas at `fps`, ticking from a worker (background tabs throttle main-thread timers). */
function canvasStream(
	width: number,
	height: number,
	fps: number,
	draw: (ctx: CanvasRenderingContext2D, t: number) => void,
) {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("2d canvas unavailable");
	const started = performance.now();
	const tick = () => draw(ctx, (performance.now() - started) / 1000);
	const ticker = new Worker(
		URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${1000 / fps})`], { type: "text/javascript" })),
	);
	ticker.onmessage = tick;
	tick();
	return { stream: canvas.captureStream(fps), stopTicker: () => ticker.terminate() };
}

/** A 1080p "slide" with small text (to judge legibility) and a moving pointer. */
function slideSource(label: string): { stream: MediaStream; stop: () => void } {
	const { stream, stopTicker } = canvasStream(SCREEN.width, SCREEN.height, SCREEN.framerate, (ctx, t) => {
		const { width, height } = ctx.canvas;
		ctx.fillStyle = "#f5f5f4";
		ctx.fillRect(0, 0, width, height);
		ctx.fillStyle = "#1c1917";
		ctx.font = "bold 72px system-ui, sans-serif";
		ctx.fillText(`${label}'s slides`, 120, 180);
		ctx.font = "32px system-ui, sans-serif";
		const bullets = [
			"Media over QUIC: one broadcast per participant",
			"Screen share is a second broadcast: <pid>/screen",
			"Groups = GoPs; relays drop whole groups under congestion",
		];
		for (const [i, b] of bullets.entries()) ctx.fillText(`•  ${b}`, 140, 320 + i * 70);
		ctx.font = "16px ui-monospace, monospace";
		for (let i = 0; i < 12; i++)
			ctx.fillText(
				`small print line ${i + 1}: the quick brown fox jumps over the lazy dog 0123456789`,
				140,
				620 + i * 24,
			);
		ctx.font = "28px ui-monospace, monospace";
		ctx.fillText(new Date().toISOString().slice(11, 23), width - 360, height - 60);
		// Pointer moving in a circle.
		const x = width / 2 + Math.cos(t) * 400;
		const y = height / 2 + Math.sin(t) * 200;
		ctx.fillStyle = "#dc2626";
		ctx.beginPath();
		ctx.arc(x, y, 14, 0, Math.PI * 2);
		ctx.fill();
	});
	return {
		stream,
		stop: () => {
			stopTicker();
			stopAll(stream);
		},
	};
}

function testSource(label: string): { stream: MediaStream; stop: () => void } {
	const hue = [...label].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
	const { stream: video, stopTicker } = canvasStream(CAMERA.width, CAMERA.height, CAMERA.framerate, (ctx, t) => {
		const canvas = ctx.canvas;
		ctx.fillStyle = `hsl(${hue} 45% 22%)`;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		// A sweeping bar makes dropped or frozen frames obvious.
		const x = ((t * 160) % (canvas.width + 60)) - 60;
		ctx.fillStyle = `hsl(${hue} 80% 60%)`;
		ctx.fillRect(x, 0, 60, canvas.height);
		ctx.fillStyle = "white";
		ctx.font = "bold 36px system-ui, sans-serif";
		ctx.fillText(label, 24, 56);
		ctx.font = "24px ui-monospace, monospace";
		ctx.fillText(new Date().toISOString().slice(11, 23), 24, canvas.height - 28);
	});

	// A short 440 Hz beep each second.
	const audioCtx = new AudioContext({ sampleRate: 48_000 });
	const osc = audioCtx.createOscillator();
	const gain = audioCtx.createGain();
	const dest = audioCtx.createMediaStreamDestination();
	dest.channelCount = 1;
	osc.frequency.value = 440;
	gain.gain.value = 0;
	osc.connect(gain).connect(dest);
	osc.start();
	for (let i = 0; i < 3600; i++) {
		gain.gain.setValueAtTime(0.2, audioCtx.currentTime + i);
		gain.gain.setValueAtTime(0, audioCtx.currentTime + i + 0.12);
	}

	const stream = new MediaStream([...video.getVideoTracks(), ...dest.stream.getAudioTracks()]);
	return {
		stream,
		stop: () => {
			stopTicker();
			stopAll(stream);
			void audioCtx.close();
		},
	};
}
