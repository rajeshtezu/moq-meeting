import { VIDEO } from "./video-publisher";

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
			video: { width: { ideal: VIDEO.width }, height: { ideal: VIDEO.height }, frameRate: { ideal: VIDEO.framerate } },
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
		});
		return {
			stream,
			stop: () =>
				stream.getTracks().forEach((t) => {
					t.stop();
				}),
		};
	}
	return testSource(label);
}

function testSource(label: string): { stream: MediaStream; stop: () => void } {
	const canvas = document.createElement("canvas");
	canvas.width = VIDEO.width;
	canvas.height = VIDEO.height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("2d canvas unavailable");
	const hue = [...label].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
	const started = performance.now();

	const draw = () => {
		const t = (performance.now() - started) / 1000;
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
	};
	// Tick from a worker: main-thread timers and rAF are throttled in background tabs,
	// which would freeze the pattern when testing with several tabs.
	const ticker = new Worker(
		URL.createObjectURL(
			new Blob([`setInterval(() => postMessage(0), ${1000 / VIDEO.framerate})`], { type: "text/javascript" }),
		),
	);
	ticker.onmessage = draw;
	draw();
	const video = canvas.captureStream(VIDEO.framerate);

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
			ticker.terminate();
			stream.getTracks().forEach((t) => {
				t.stop();
			});
			void audioCtx.close();
		},
	};
}
