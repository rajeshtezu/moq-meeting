import type { Presence } from "@moq-meeting/shared";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { joinRoom, savedName, saveName } from "../api";
import { Card } from "../components/Card";
import { type ChatEntry, ChatPanel } from "../components/ChatPanel";
import { CamIcon, ChatIcon, MicIcon, ScreenIcon } from "../components/Icons";
import { PeerTile } from "../components/PeerTile";
import { LocalScreen, RemoteScreen } from "../components/ScreenTile";
import { SelfTile } from "../components/SelfTile";
import { AudioOut } from "../media/audio-out";
import { captureLocal, captureScreen, type SourceKind } from "../media/capture";
import { RoomSession } from "../moq/session";

type Status =
	| { kind: "connecting" }
	| { kind: "connected"; transport: string }
	| { kind: "reconnecting" }
	| { kind: "error"; message: string };

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
	const [presences, setPresences] = useState<Record<string, Presence>>({});
	const [self, setSelf] = useState<Presence>();
	const [chat, setChat] = useState<ChatEntry[]>([]);
	/** Peers currently sharing, in the order they started. */
	const [screens, setScreens] = useState<string[]>([]);
	const [myScreen, setMyScreen] = useState<{ stream: MediaStream; stop: () => void }>();
	const myScreenRef = useRef<{ stream: MediaStream; stop: () => void }>(undefined);
	/** Which share is on the big stage: a peer ID, or "self". Defaults to the newest share. */
	const [spotlight, setSpotlight] = useState<string>();
	const [screenError, setScreenError] = useState<string>();
	const [chatOpen, setChatOpen] = useState(false);
	const [unread, setUnread] = useState(0);
	const chatOpenRef = useRef(false);
	/** Last known name per participant; kept after they leave so their messages stay attributed. */
	const names = useRef<Record<string, string>>({});
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
					onPeerLeft: (id) => {
						setPeers((p) => p.filter((x) => x !== id));
						setScreens((list) => list.filter((x) => x !== id));
						setPresences(({ [id]: _, ...rest }) => rest);
					},
					onPresence: (id, presence) => {
						names.current[id] = presence.name;
						setPresences((p) => ({ ...p, [id]: presence }));
					},
					onStatus: (st) =>
						setStatus(
							st === "connected"
								? { kind: "connected", transport: current.current?.session.transport ?? "unknown" }
								: { kind: "reconnecting" },
						),
					onScreen: (id, sharing) => {
						setScreens((list) => (sharing ? [...list.filter((x) => x !== id), id] : list.filter((x) => x !== id)));
						if (sharing) setSpotlight(id);
					},
					onChat: (from, m) => {
						addChat({ key: `${from}:${m.id}`, from, text: m.text, sentAt: m.sentAt, mine: false });
						if (!chatOpenRef.current) setUnread((n) => n + 1);
					},
					onClosed: (err) => setStatus({ kind: "error", message: err ? String(err) : "disconnected" }),
				},
				media.stream,
			);
			const j = { session, audioOut, stream: media.stream, stopMedia: media.stop };
			current.current = j;
			setJoined(j);
			setSelf(session.presence);
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

	/** Merge into one timeline ordered by send time; dedupe by key. */
	function addChat(entry: ChatEntry) {
		setChat((list) => {
			if (list.some((e) => e.key === entry.key)) return list;
			const next = [...list, entry];
			next.sort((a, b) => a.sentAt - b.sentAt || a.key.localeCompare(b.key));
			return next;
		});
	}

	function sendChat(text: string): string | undefined {
		const s = current.current?.session;
		if (!s) return "not connected";
		try {
			const m = s.sendChat(text);
			addChat({ key: `${s.participantId}:${m.id}`, from: s.participantId, text: m.text, sentAt: m.sentAt, mine: true });
			return undefined;
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
	}

	function stopShare() {
		const share = myScreenRef.current;
		myScreenRef.current = undefined;
		current.current?.session.stopScreenShare();
		share?.stop();
		setMyScreen(undefined);
	}

	async function toggleScreen() {
		if (myScreenRef.current) return stopShare();
		const s = current.current?.session;
		if (!s) return;
		setScreenError(undefined);
		try {
			// Stopping from the browser's own "Stop sharing" bar ends the track; treat it like our button.
			const share = await captureScreen(source, s.name, stopShare);
			myScreenRef.current = share;
			s.startScreenShare(share.stream);
			setMyScreen(share);
			setSpotlight("self");
		} catch (err) {
			// Dismissing the picker is a NotAllowedError; not worth an error message.
			if (!(err instanceof DOMException && err.name === "NotAllowedError")) setScreenError(String(err));
		}
	}

	function toggleChat() {
		const open = !chatOpenRef.current;
		chatOpenRef.current = open;
		setChatOpen(open);
		if (open) setUnread(0);
	}

	function toggleMic() {
		const s = current.current?.session;
		if (!s) return;
		s.setMic(!s.presence.mic);
		setSelf(s.presence);
	}

	function toggleCam() {
		const s = current.current?.session;
		if (!s) return;
		s.setCam(!s.presence.cam);
		setSelf(s.presence);
	}

	function leave() {
		stopShare();
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

	if (!joined || !self) {
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
	const shares = [...(myScreen ? ["self"] : []), ...screens];
	const stage = spotlight && shares.includes(spotlight) ? spotlight : shares.at(-1);
	const nameOf = (id: string) => (id === "self" ? "You" : (presences[id]?.name ?? names.current[id] ?? "Someone"));
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
					className={`rounded-full px-2.5 py-0.5 text-xs ${status.kind === "connected" ? "bg-ok/15 text-ok" : status.kind === "error" ? "bg-bad/15 text-bad" : status.kind === "reconnecting" ? "bg-yellow-500/15 text-yellow-400" : "text-muted"}`}
				>
					{status.kind === "connected"
						? `connected (${status.transport})`
						: status.kind === "error"
							? status.message
							: status.kind === "reconnecting"
								? "reconnecting…"
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
				</div>
			</header>

			<div className="flex min-h-0 flex-1">
				{stage ? (
					// Spotlight: the share on the big stage, participants in a strip beside (or below) it.
					<main className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:flex-row" data-testid="spotlight">
						<section className="flex min-h-[50vh] flex-1 flex-col gap-2">
							{shares.length > 1 && (
								<div className="flex flex-wrap gap-2" data-testid="share-switcher">
									{shares.map((id) => (
										<button
											key={id}
											type="button"
											className={id === stage ? "btn-primary" : "btn-ghost"}
											onClick={() => setSpotlight(id)}
										>
											{nameOf(id)}
										</button>
									))}
								</div>
							)}
							<div className="min-h-0 flex-1">
								{stage === "self" && myScreen ? (
									<LocalScreen stream={myScreen.stream} />
								) : (
									<RemoteScreen
										key={stage}
										id={stage}
										name={nameOf(stage)}
										session={joined.session}
										audioOut={joined.audioOut}
									/>
								)}
							</div>
						</section>
						<aside
							className="flex shrink-0 gap-3 overflow-auto max-lg:[&>*]:w-56 max-lg:[&>*]:shrink-0 lg:w-64 lg:flex-col [&_[data-testid=stats]]:hidden"
							data-testid="grid"
						>
							<SelfTile
								presence={self}
								stream={joined.stream}
								context={joined.audioOut.context}
								mirror={source === "camera"}
							/>
							{peers.map((id) => (
								<PeerTile
									key={id}
									id={id}
									presence={presences[id]}
									session={joined.session}
									audioOut={joined.audioOut}
								/>
							))}
						</aside>
					</main>
				) : (
					<main className={`grid flex-1 content-center gap-3 p-4 ${cols}`} data-testid="grid">
						<SelfTile
							presence={self}
							stream={joined.stream}
							context={joined.audioOut.context}
							mirror={source === "camera"}
						/>
						{peers.map((id) => (
							<PeerTile key={id} id={id} presence={presences[id]} session={joined.session} audioOut={joined.audioOut} />
						))}
					</main>
				)}
				{chatOpen && (
					<ChatPanel
						entries={chat}
						nameOf={(id) => names.current[id] ?? "Someone"}
						onSend={sendChat}
						onClose={toggleChat}
					/>
				)}
			</div>

			<footer className="flex justify-center gap-3 border-t border-line bg-surface px-4 py-3">
				<button
					type="button"
					data-testid="toggle-mic"
					aria-pressed={!self.mic}
					className={self.mic ? "btn-ghost" : "btn-danger"}
					onClick={toggleMic}
					disabled={!joined.stream.getAudioTracks().length}
				>
					<MicIcon off={!self.mic} />
					{self.mic ? "Mute" : "Unmute"}
				</button>
				<button
					type="button"
					data-testid="toggle-cam"
					aria-pressed={!self.cam}
					className={self.cam ? "btn-ghost" : "btn-danger"}
					onClick={toggleCam}
					disabled={!joined.stream.getVideoTracks().length}
				>
					<CamIcon off={!self.cam} />
					{self.cam ? "Stop video" : "Start video"}
				</button>
				<button
					type="button"
					data-testid="toggle-chat"
					aria-pressed={chatOpen}
					className="btn-ghost relative"
					onClick={toggleChat}
				>
					<ChatIcon />
					Chat
					{unread > 0 && (
						<span
							data-testid="unread"
							className="absolute -top-1.5 -right-1.5 grid min-w-5 place-items-center rounded-full bg-accent px-1 text-[11px] text-white"
						>
							{unread > 99 ? "99+" : unread}
						</span>
					)}
				</button>
				<button
					type="button"
					data-testid="toggle-screen"
					aria-pressed={!!myScreen}
					className={myScreen ? "btn-primary" : "btn-ghost"}
					onClick={toggleScreen}
					title={screenError}
				>
					<ScreenIcon />
					{myScreen ? "Stop sharing" : "Share screen"}
				</button>
				<button type="button" className="btn-danger" onClick={leave}>
					Leave
				</button>
			</footer>
			{screenError && (
				<p className="bg-surface px-4 pb-3 text-center text-xs text-bad">Screen share failed: {screenError}</p>
			)}
		</div>
	);
}
