import type { Presence } from "@moq-meeting/shared";
import { useEffect, useRef, useState } from "react";
import { LocalSpeaking } from "../media/speaking";
import { Tile } from "./Tile";

interface Props {
	presence: Presence;
	stream: MediaStream;
	context: AudioContext;
	/** Mirror the preview (cameras), not the test pattern. */
	mirror: boolean;
	/** Encoder target and bandwidth grant, polled for the stats overlay. */
	sendStats?: () => { bitrate: number; grant: number | undefined; rtt: number | undefined } | undefined;
}

const kbps = (bps: number) => `${Math.round(bps / 1000)} kbps`;

export function SelfTile({ presence, stream, context, mirror, sendStats }: Props) {
	const video = useRef<HTMLVideoElement>(null);
	const [speaking, setSpeaking] = useState(false);
	const [send, setSend] = useState<string>();
	// Latest getter in a ref: the prop is a fresh arrow each render.
	const sendStatsRef = useRef(sendStats);
	sendStatsRef.current = sendStats;

	useEffect(() => {
		const poll = setInterval(() => {
			const s = sendStatsRef.current?.();
			setSend(
				s?.bitrate ? `↑ ${kbps(s.bitrate)}${s.grant !== undefined ? ` · grant ${kbps(s.grant)}` : ""}` : undefined,
			);
		}, 1000);
		return () => clearInterval(poll);
	}, []);

	useEffect(() => {
		if (video.current) video.current.srcObject = stream;
	}, [stream]);

	useEffect(() => {
		const [track] = stream.getAudioTracks();
		if (!track) return;
		const local = new LocalSpeaking(context, track);
		const poll = setInterval(() => setSpeaking(local.speaking()), 150);
		return () => {
			clearInterval(poll);
			local.close();
		};
	}, [stream, context]);

	return (
		<Tile
			testId="self-tile"
			label={presence.name}
			badge="you"
			stats={presence.cam ? send : undefined}
			speaking={speaking && presence.mic}
			micOff={!presence.mic}
			camOff={!presence.cam}
		>
			<video
				ref={video}
				autoPlay
				muted
				playsInline
				className={`h-full w-full object-cover ${mirror ? "-scale-x-100" : ""}`}
			/>
		</Tile>
	);
}
