import { type FormEvent, useEffect, useRef, useState } from "react";
import { joinRoom, savedName, saveName } from "../api";
import { type HelloMessage, RoomSession } from "../moq/session";

type Status =
	| { kind: "idle" }
	| { kind: "connecting" }
	| { kind: "connected"; transport: string }
	| { kind: "error"; message: string };

/** Phase 0 spike room: join with a JWT, see who else is announced, exchange text frames. */
export function Room({ roomId }: { roomId: string }) {
	const [name, setName] = useState(savedName);
	const [joined, setJoined] = useState(false);
	const [status, setStatus] = useState<Status>({ kind: "idle" });
	const [peers, setPeers] = useState<string[]>([]);
	const [messages, setMessages] = useState<HelloMessage[]>([]);
	const [draft, setDraft] = useState("");
	const session = useRef<RoomSession>(undefined);

	useEffect(() => {
		if (!joined) return;
		let cancelled = false;
		setStatus({ kind: "connecting" });

		(async () => {
			try {
				const token = await joinRoom(roomId, name);
				const s = await RoomSession.join(token, {
					onPeerJoined: (id) => setPeers((p) => [...p, id]),
					onPeerLeft: (id) => setPeers((p) => p.filter((x) => x !== id)),
					onMessage: (m) => setMessages((list) => [...list, m]),
					onClosed: (err) => !cancelled && setStatus({ kind: "error", message: err ? String(err) : "disconnected" }),
				});
				if (cancelled) return s.close();
				session.current = s;
				setStatus({ kind: "connected", transport: s.transport });
			} catch (err) {
				if (!cancelled) setStatus({ kind: "error", message: String(err) });
			}
		})();

		return () => {
			cancelled = true;
			session.current?.close();
			session.current = undefined;
		};
	}, [joined, roomId, name]);

	function onJoin(e: FormEvent) {
		e.preventDefault();
		saveName(name.trim());
		setJoined(true);
	}

	function onSend(e: FormEvent) {
		e.preventDefault();
		const s = session.current;
		if (!s || !draft.trim()) return;
		s.send(draft.trim());
		setMessages((list) => [...list, { from: s.participantId, name: s.name, text: draft.trim(), sentAt: Date.now() }]);
		setDraft("");
	}

	if (!joined) {
		return (
			<main className="card">
				<h1>Join room {roomId}</h1>
				<form onSubmit={onJoin}>
					<label>
						Your name
						<input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
					</label>
					<button type="submit" disabled={!name.trim()}>
						Join
					</button>
				</form>
			</main>
		);
	}

	return (
		<main className="card wide">
			<header>
				<h1>Room {roomId}</h1>
				<span className={`status ${status.kind}`} data-testid="status">
					{status.kind === "connected"
						? `connected (${status.transport})`
						: status.kind === "error"
							? status.message
							: status.kind}
				</span>
			</header>
			<p className="muted">
				Share this link: <code>{window.location.href}</code>
			</p>

			<section>
				<h2>Peers ({peers.length})</h2>
				<ul data-testid="peers">
					{peers.map((id) => (
						<li key={id}>
							<code>{id}</code>
						</li>
					))}
				</ul>
			</section>

			<section>
				<h2>Hello track</h2>
				<ul className="messages" data-testid="messages">
					{messages.map((m) => (
						<li key={`${m.from}-${m.sentAt}`}>
							<strong>{m.from === session.current?.participantId ? "you" : m.name}</strong>: {m.text}
						</li>
					))}
				</ul>
				<form onSubmit={onSend} className="row">
					<input
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder="Say hello"
						disabled={status.kind !== "connected"}
					/>
					<button type="submit" disabled={status.kind !== "connected" || !draft.trim()}>
						Send
					</button>
				</form>
			</section>
		</main>
	);
}
