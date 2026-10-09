/**
 * Conventions shared by the Bun server and the browser client.
 *
 * A client dials `<relayUrl>/rooms/<roomId>?jwt=…`, so every broadcast path below is
 * relative to the room: a participant publishes `<participantId>` (and later
 * `<participantId>/screen`), and discovers everyone else by listening to announcements.
 */

/** Room and participant IDs: URL-safe, short, and never containing `/`. */
const ID_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;

export function isValidId(id: string): boolean {
	return ID_PATTERN.test(id);
}

const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

/** Random ID with ~51 bits of entropy (10 chars of a 33-char alphabet). */
export function randomId(length = 10): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let id = "";
	for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
	return id;
}

/** JWT `root` and the relay URL path for a room. */
export function roomPath(roomId: string): string {
	return `rooms/${roomId}`;
}

/** Track names published inside each participant broadcast. */
export const Tracks = {
	/** Phase 0 spike: plain text frames. */
	hello: "hello",
	catalog: "catalog.json",
	video: "video",
	audio: "audio",
	presence: "presence",
	chat: "chat",
} as const;

export const MAX_NAME_LENGTH = 40;

export interface CreateRoomResponse {
	roomId: string;
}

export interface TokenRequest {
	name: string;
}

export interface TokenResponse {
	roomId: string;
	participantId: string;
	name: string;
	/** Full relay URL for this room, including the `?jwt=` query. */
	relayUrl: string;
	/** Unix seconds. */
	expiresAt: number;
	/**
	 * SHA-256 of the relay's self-signed certificate (hex). Only set in local dev;
	 * with a real certificate the browser verifies the relay normally.
	 */
	certificateHash?: string;
}

export interface ApiError {
	error: string;
}
