import { useEffect, useRef } from "react";
import { Tile } from "./Tile";

/** Local preview; mirrored for a camera so it behaves like a mirror. */
export function SelfTile({ name, stream, mirror }: { name: string; stream: MediaStream; mirror: boolean }) {
	const video = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		if (video.current) video.current.srcObject = stream;
	}, [stream]);
	return (
		<Tile label={name} badge="you">
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
