import type { Presence } from "@moq-meeting/shared";
import { useEffect, useRef, useState } from "react";
import type { AudioOut } from "../media/audio-out";
import { PeerMedia, type PeerStats } from "../media/peer-media";
import type { RoomSession } from "../moq/session";
import { Tile } from "./Tile";

function formatStats(s: PeerStats | undefined): string | undefined {
	if (!s) return undefined;
	const video = [`${s.fps} fps`, s.height ? `${s.height}p` : undefined, s.codec?.split(".")[0], `${s.videoKbps} kbps`];
	const net = [
		s.videoLatencyMs !== undefined ? `v ${s.videoLatencyMs} ms` : undefined,
		s.audioLatencyMs !== undefined ? `a ${s.audioLatencyMs} ms` : undefined,
		s.videoPaused ? "video paused" : `skip ${s.videoSkips}`,
		s.audio ? `gap ${s.audioUnderruns} · jb ${s.audioBufferMs}` : "no audio",
		s.audioLevelDb !== undefined ? `♪ ${s.audioLevelDb} dB` : undefined,
	];
	return [video, net].map((l) => l.filter(Boolean).join(" · ")).join("\n");
}

interface Props {
	id: string;
	presence: Presence | undefined;
	session: RoomSession;
	audioOut: AudioOut;
}

export function PeerTile({ id, presence, session, audioOut }: Props) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const [stats, setStats] = useState<PeerStats>();
	const [speaking, setSpeaking] = useState(false);

	useEffect(() => {
		const request = session.peer(id);
		if (!request || !canvas.current) return;
		const media = new PeerMedia(request, canvas.current, audioOut, setStats);
		const poll = setInterval(() => setSpeaking(media.speaking), 150);
		return () => {
			clearInterval(poll);
			media.close();
		};
	}, [id, session, audioOut]);

	// Until presence arrives, show the tile with a neutral label rather than the raw ID.
	const name = presence?.name ?? "Joining…";
	const camOff = presence ? !presence.cam : !stats?.fps;
	const notice = stats?.videoPaused && !camOff ? "Video paused: weak connection" : undefined;

	return (
		<Tile
			testId="peer-tile"
			label={name}
			stats={formatStats(stats)}
			speaking={speaking && presence?.mic !== false}
			micOff={presence?.mic === false}
			camOff={camOff || !!notice}
			notice={notice}
		>
			<canvas ref={canvas} className="h-full w-full object-contain" data-peer={id} />
		</Tile>
	);
}
