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
}

export function SelfTile({ presence, stream, context, mirror }: Props) {
	const video = useRef<HTMLVideoElement>(null);
	const [speaking, setSpeaking] = useState(false);

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
