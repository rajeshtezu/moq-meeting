/**
 * Phase 0 exit check, headless: two participants exchange a hello frame through the relay,
 * and a token for one room is refused on another. Runs over the relay's WebSocket fallback
 * because Bun has no WebTransport. Works against local dev (`bun run dev`) or a deployment.
 *
 *   bun run smoke [http://localhost:3000 | https://meet.example.com]
 */

import * as Moq from "@moq/net";
import type { TokenResponse } from "@moq-meeting/shared";
import { type HelloMessage, RoomSession } from "../apps/web/src/moq/session";

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

const noop = { onPeerJoined() {}, onPeerLeft() {}, onMessage() {}, onClosed() {} };
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
let resolveMsg: (m: HelloMessage) => void = () => {};
const joined = new Promise<string>((r) => (resolveJoin = r));
const received = new Promise<HelloMessage>((r) => (resolveMsg = r));

const bob = await RoomSession.join(overWebSocket(tokenB), {
	...noop,
	onPeerJoined: resolveJoin,
	onMessage: resolveMsg,
});
const alice = await RoomSession.join(overWebSocket(tokenA), noop);

const peer = await withTimeout(joined, 5000, "bob sees alice announced");
check(peer === tokenA.participantId, "bob discovers alice via announcements");

// The subscription starts at the latest group, so keep sending until one lands.
const sender = setInterval(() => alice.send("hello from alice"), 200);
const msg = await withTimeout(received, 5000, "bob receives alice's frame").finally(() => clearInterval(sender));
check(msg.text === "hello from alice" && msg.name === "alice", "bob receives alice's hello frame");

// 2. Leaving retracts the announcement.
let resolveLeft: (id: string) => void = () => {};
const left = new Promise<string>((r) => (resolveLeft = r));
const bob2 = await RoomSession.join(
	overWebSocket(await post<TokenResponse>(`/api/rooms/${roomId}/token`, { name: "carol" })),
	{
		...noop,
		onPeerLeft: resolveLeft,
	},
);
await Bun.sleep(300);
alice.close();
check(
	(await withTimeout(left, 5000, "alice retraction")) === tokenA.participantId,
	"leaving retracts the announcement",
);

// 3. A token for this room is refused on another room's path.
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

// 4. A participant can't publish under someone else's ID: carol must never see it announced.
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
