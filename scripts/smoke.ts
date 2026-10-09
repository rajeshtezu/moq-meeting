/**
 * Headless end-to-end check: participants discover each other, exchange chat and presence,
 * and a token for one room is refused on another. Runs over the relay's WebSocket fallback
 * because Bun has no WebTransport. Works against local dev (`bun run dev`) or a deployment.
 *
 *   bun run smoke [http://localhost:3000 | https://meet.example.com]
 */

import * as Moq from "@moq/net";
import type { ChatMessage, Presence, TokenResponse } from "@moq-meeting/shared";
import { RoomSession } from "../apps/web/src/moq/session";

const base = process.argv[2] ?? "http://localhost:3000";

async function post<T>(path: string, body?: unknown): Promise<T> {
	const res = await fetch(new URL(path, base), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
	return res.json() as Promise<T>;
}

/**
 * Bun has no WebTransport, so @moq/net uses the WebSocket fallback (https → wss).
 * A dev relay's self-signed cert can't be pinned for wss, so dial its plain-HTTP
 * listener instead; a production relay with a real cert is used as-is.
 */
function overWebSocket(token: TokenResponse): TokenResponse {
	if (!token.certificateHash) return token;
	const url = new URL(token.relayUrl);
	url.protocol = "http:";
	return { ...token, relayUrl: url.toString(), certificateHash: undefined };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([p, Bun.sleep(ms).then(() => Promise.reject(new Error(`timed out: ${what}`)))]);
}

const noop = { onPeerJoined() {}, onPeerLeft() {}, onClosed() {} };
let failed = false;
function check(ok: boolean, label: string) {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) failed = true;
}

const { roomId } = await post<{ roomId: string }>("/api/rooms");
const tokenA = await post<TokenResponse>(`/api/rooms/${roomId}/token`, { name: "alice" });
const tokenB = await post<TokenResponse>(`/api/rooms/${roomId}/token`, { name: "bob" });

// 1. Bob discovers Alice and receives her frame.
let resolveJoin: (id: string) => void = () => {};
let resolveMsg: (m: { from: string; message: ChatMessage }) => void = () => {};
const joined = new Promise<string>((r) => (resolveJoin = r));
const received = new Promise<{ from: string; message: ChatMessage }>((r) => (resolveMsg = r));

/** Latest presence per peer, as seen by bob, plus a way to wait for a matching value. */
const bobSees = new Map<string, Presence>();
const presenceWaiters: { pred: (id: string, p: Presence) => boolean; resolve: () => void }[] = [];
function waitForPresence(pred: (id: string, p: Presence) => boolean): Promise<void> {
	for (const [id, p] of bobSees) if (pred(id, p)) return Promise.resolve();
	return new Promise((resolve) => presenceWaiters.push({ pred, resolve }));
}

const bob = await RoomSession.join(overWebSocket(tokenB), {
	...noop,
	onPeerJoined: resolveJoin,
	onChat: (from, message) => resolveMsg({ from, message }),
	onPresence: (id, p) => {
		bobSees.set(id, p);
		for (const w of presenceWaiters.splice(0))
			if (w.pred(id, p)) w.resolve();
			else presenceWaiters.push(w);
	},
});
const alice = await RoomSession.join(overWebSocket(tokenA), noop);

const peer = await withTimeout(joined, 5000, "bob sees alice announced");
check(peer === tokenA.participantId, "bob discovers alice via announcements");

// Chat is one lossless group per session, so a message sent before bob subscribed still arrives.
alice.sendChat("hello from alice");
const msg = await withTimeout(received, 5000, "bob receives alice's chat");
check(
	msg.from === tokenA.participantId && msg.message.text === "hello from alice",
	"bob receives alice's chat message",
);

// 2. Presence: names arrive, and a mic toggle reaches peers within a second.
const aliceId = tokenA.participantId;
await withTimeout(
	waitForPresence((id, p) => id === aliceId && p.name === "alice"),
	5000,
	"alice's presence",
);
check(true, "bob sees alice's name via presence");
const toggledAt = performance.now();
alice.setMic(true);
await withTimeout(
	waitForPresence((id, p) => id === aliceId && p.mic),
	1000,
	"mic toggle within 1 s",
);
check(true, `presence update delivered in ${Math.round(performance.now() - toggledAt)} ms`);

// 3. Leaving retracts the announcement, and a late joiner sees current presence.
let resolveLeft: (id: string) => void = () => {};
let carolSaw: Presence | undefined;
const carolChat: string[] = [];
const left = new Promise<string>((r) => (resolveLeft = r));
const bob2 = await RoomSession.join(
	overWebSocket(await post<TokenResponse>(`/api/rooms/${roomId}/token`, { name: "carol" })),
	{
		...noop,
		onPeerLeft: resolveLeft,
		onPresence: (id, p) => {
			if (id === aliceId) carolSaw = p;
		},
		onChat: (from, m) => {
			if (from === aliceId) carolChat.push(m.text);
		},
	},
);
await Bun.sleep(300);
check(carolSaw?.mic === true && carolSaw.name === "alice", "late joiner gets alice's current presence (mic on)");
check(carolChat.join("|") === "hello from alice", "late joiner gets alice's chat history");

// Chat is throttled at the source: the log never rolls, so a flood would grow it unbounded.
let throttled = false;
try {
	for (let i = 0; i < 10; i++) alice.sendChat(`spam ${i}`);
} catch {
	throttled = true;
}
check(throttled, "chat is rate-limited at the sender");
alice.close();
check(
	(await withTimeout(left, 5000, "alice retraction")) === tokenA.participantId,
	"leaving retracts the announcement",
);

// 4. A token for this room is refused on another room's path.
const otherRoom = (await post<{ roomId: string }>("/api/rooms")).roomId;
const stolen = new URL(overWebSocket(tokenB).relayUrl);
stolen.pathname = `/rooms/${otherRoom}`;
const refused = await Moq.Connection.connect({ url: stolen }).then(
	(c) => {
		c.close();
		return false;
	},
	() => true,
);
check(refused, "token for room A refused on room B");

// 5. A participant can't publish under someone else's ID: carol must never see it announced.
const victim = "victim0000";
const seen: string[] = [];
const observer = await RoomSession.join(
	overWebSocket(await post<TokenResponse>(`/api/rooms/${roomId}/token`, { name: "dave" })),
	{
		...noop,
		onPeerJoined: (id) => seen.push(id),
	},
);
const impostor = await RoomSession.join(overWebSocket({ ...tokenB, participantId: victim }), noop).catch(
	() => undefined,
);
await Bun.sleep(1500);
check(!seen.includes(victim), "publishing under another participant's path is refused");
impostor?.close();
observer.close();

bob.close();
bob2.close();
console.log(failed ? "\nsmoke FAILED" : "\nsmoke passed");
process.exit(failed ? 1 : 0);
