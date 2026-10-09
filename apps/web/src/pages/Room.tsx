import { type FormEvent, useEffect, useRef, useState } from "react";
import { joinRoom, savedName, saveName } from "../api";
import { Card } from "../components/Card";
import { PeerTile } from "../components/PeerTile";
import { SelfTile } from "../components/SelfTile";
import { AudioOut } from "../media/audio-out";
import { captureLocal, type SourceKind } from "../media/capture";
import { RoomSession } from "../moq/session";

type Status = { kind: "connecting" } | { kind: "connected"; transport: string } | { kind: "error"; message: string };

interface Joined {
	session: RoomSession;
	audioOut: AudioOut;
	stream: MediaStream;
	stopMedia: () => void;
}

function initialSource(): SourceKind {
	return new URLSearchParams(window.location.search).get("source") === "test" ? "test" : "camera";
}

export function Room({ roomId }: { roomId: string }) {
	const [name, setName] = useState(savedName);
	const [source, setSource] = useState<SourceKind>(initialSource);
	const [joined, setJoined] = useState<Joined>();
	const [status, setStatus] = useState<Status>({ kind: "connecting" });
	const [peers, setPeers] = useState<string[]>([]);
	const [joinError, setJoinError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const current = useRef<Joined>(undefined);

	async function onJoin(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		setJoinError(undefined);
		saveName(name.trim());

		// Created inside the click so the browser allows audio playback.
		const audioOut = new AudioOut();
		let media: { stream: MediaStream; stop: () => void } | undefined;
		try {
			media = await captureLocal(source, name.trim());
			const token = await joinRoom(roomId, name.trim());
			const session = await RoomSession.join(
				token,
				{
					onPeerJoined: (id) => setPeers((p) => (p.includes(id) ? p : [...p, id])),
					onPeerLeft: (id) => setPeers((p) => p.filter((x) => x !== id)),
					onMessage: () => {},
					onClosed: (err) => setStatus({ kind: "error", message: err ? String(err) : "disconnected" }),
				},
				media.stream,
			);
			const j = { session, audioOut, stream: media.stream, stopMedia: media.stop };
			current.current = j;
			setJoined(j);
			setStatus({ kind: "connected", transport: session.transport });
		} catch (err) {
			media?.stop();
			audioOut.close();
			setJoinError(
				err instanceof DOMException && err.name === "NotAllowedError"
					? "Camera/mic permission denied. Try the test source."
					: String(err),
			);
		} finally {
			setBusy(false);
		}
	}

	function leave() {
		const j = current.current;
		current.current = undefined;
		j?.session.close();
		j?.stopMedia();
		j?.audioOut.close();
		window.location.assign("/");
	}

	useEffect(() => {
		const onUnload = () => current.current?.session.close();
		window.addEventListener("pagehide", onUnload);
		return () => window.removeEventListener("pagehide", onUnload);
	}, []);

	if (!joined) {
		return (
			<Card title={`Join room ${roomId}`}>
				<form onSubmit={onJoin} className="grid gap-4">
					<label className="grid gap-1.5 text-sm text-muted">
						Your name
						<input
							className="field text-neutral-100"
							value={name}
							onChange={(e) => setName(e.target.value)}
							maxLength={40}
							required
						/>
					</label>
					<label className="grid gap-1.5 text-sm text-muted">
						Media source
						<select
							className="field text-neutral-100"
							value={source}
							onChange={(e) => setSource(e.target.value as SourceKind)}
						>
							<option value="camera">Camera &amp; microphone</option>
							<option value="test">Test pattern &amp; tone</option>
						</select>
					</label>
					<button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
						{busy ? "Joining…" : "Join"}
					</button>
				</form>
				{joinError && <p className="mt-4 text-sm text-bad">{joinError}</p>}
			</Card>
		);
	}

	const count = peers.length + 1;
	const cols =
		count <= 1
			? "grid-cols-1"
			: count <= 4
				? "sm:grid-cols-2"
				: count <= 6
					? "sm:grid-cols-2 lg:grid-cols-3"
					: "sm:grid-cols-3 lg:grid-cols-4";

	return (
		<div className="flex min-h-screen flex-col">
			<header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3">
				<h1 className="font-semibold">Room {roomId}</h1>
				<span
					data-testid="status"
					className={`rounded-full px-2.5 py-0.5 text-xs ${status.kind === "connected" ? "bg-ok/15 text-ok" : status.kind === "error" ? "bg-bad/15 text-bad" : "text-muted"}`}
				>
					{status.kind === "connected"
						? `connected (${status.transport})`
						: status.kind === "error"
							? status.message
							: "connecting"}
				</span>
				<span className="text-xs text-muted">
					{count} participant{count === 1 ? "" : "s"}
				</span>
				<div className="ml-auto flex gap-2">
					<button
						type="button"
						className="btn-ghost"
						onClick={() => navigator.clipboard?.writeText(window.location.href.split("?")[0] ?? "")}
					>
						Copy link
					</button>
					<button type="button" className="btn-danger" onClick={leave}>
						Leave
					</button>
				</div>
			</header>

			<main className={`grid flex-1 content-center gap-3 p-4 ${cols}`} data-testid="grid">
				<SelfTile name={joined.session.name} stream={joined.stream} mirror={source === "camera"} />
				{peers.map((id) => (
					<PeerTile key={id} id={id} session={joined.session} audioOut={joined.audioOut} />
				))}
			</main>
		</div>
	);
}
