import { useEffect, useRef, useState } from "react";
import type { AudioOut } from "../media/audio-out";
import { PeerMedia, type PeerStats } from "../media/peer-media";
import type { RoomSession } from "../moq/session";
import { Tile } from "./Tile";

function formatStats(s: PeerStats | undefined): string | undefined {
	if (!s) return undefined;
	const parts = [`${s.fps} fps`];
	if (s.videoLatencyMs !== undefined) parts.push(`${s.videoLatencyMs} ms`);
	if (s.height) parts.push(`${s.height}p`);
	if (s.codec) parts.push(s.codec.split(".")[0] ?? s.codec);
	if (!s.audio) parts.push("no audio");
	else parts.push(s.audioLevelDb === undefined ? "♪ –" : `♪ ${s.audioLevelDb} dB`);
	return parts.join(" · ");
}

export function PeerTile({ id, session, audioOut }: { id: string; session: RoomSession; audioOut: AudioOut }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const [stats, setStats] = useState<PeerStats>();

	useEffect(() => {
		const request = session.peer(id);
		if (!request || !canvas.current) return;
		const media = new PeerMedia(request, canvas.current, audioOut, setStats);
		return () => media.close();
	}, [id, session, audioOut]);

	return (
		<Tile label={id} stats={formatStats(stats)}>
			<canvas ref={canvas} className="h-full w-full object-contain" data-peer={id} />
		</Tile>
	);
}
