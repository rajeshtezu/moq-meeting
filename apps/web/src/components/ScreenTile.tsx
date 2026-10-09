import { useEffect, useRef, useState } from "react";
import type { AudioOut } from "../media/audio-out";
import { PeerMedia, type PeerStats } from "../media/peer-media";
import type { RoomSession } from "../moq/session";

/** Big keyframes at 15 fps: give a late group up to 1.5 s before skipping it. */
const SCREEN_MAX_AGE_MS = 1500;

function Frame({ label, stats, children }: { label: string; stats?: string; children: React.ReactNode }) {
	return (
		<div
			data-testid="screen-tile"
			className="relative h-full w-full overflow-hidden rounded-xl border border-line bg-black"
		>
			{children}
			<div
				className="absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-1 text-xs font-medium"
				data-testid="screen-label"
			>
				{label}
			</div>
			{stats && (
				<div
					className="absolute top-2 right-2 rounded-md bg-black/60 px-2 py-1 font-mono text-[11px] text-muted"
					data-testid="screen-stats"
				>
					{stats}
				</div>
			)}
		</div>
	);
}

/** A peer's screen share, decoded onto a canvas. */
export function RemoteScreen({
	id,
	name,
	session,
	audioOut,
}: {
	id: string;
	name: string;
	session: RoomSession;
	audioOut: AudioOut;
}) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const [stats, setStats] = useState<PeerStats>();

	useEffect(() => {
		const request = session.screen(id);
		if (!request || !canvas.current) return;
		const media = new PeerMedia(request, canvas.current, audioOut, setStats, { videoMaxAgeMs: SCREEN_MAX_AGE_MS });
		return () => media.close();
	}, [id, session, audioOut]);

	const text = stats?.height
		? `${stats.fps} fps · ${stats.width}×${stats.height}${stats.videoLatencyMs !== undefined ? ` · ${stats.videoLatencyMs} ms` : ""}`
		: undefined;
	return (
		<Frame label={`${name}'s screen`} stats={text}>
			<canvas ref={canvas} className="h-full w-full object-contain" data-screen={id} />
		</Frame>
	);
}

/** Our own share: a local preview of the captured stream (no round trip). */
export function LocalScreen({ stream }: { stream: MediaStream }) {
	const video = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		if (video.current) video.current.srcObject = stream;
	}, [stream]);
	return (
		<Frame label="Your screen (others see this)">
			<video ref={video} autoPlay muted playsInline className="h-full w-full object-contain" />
		</Frame>
	);
}
