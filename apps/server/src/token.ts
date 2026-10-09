import { type Claims, Key } from "@moq/auth";
import { roomPath } from "@moq-meeting/shared";

/**
 * Claims for one participant in one room: publish only their own broadcasts
 * (`<pid>/**` covers `<pid>` itself and `<pid>/screen`), subscribe to anything in the room.
 *
 * The relay refuses unknown claims (including `aud`), so keep this to the documented set.
 */
export function participantClaims(roomId: string, participantId: string, now: number, ttlSeconds: number): Claims {
	return {
		root: roomPath(roomId),
		publish: [`${participantId}/**`],
		subscribe: ["**"],
		iat: now,
		exp: now + ttlSeconds,
	};
}

export async function loadSigningKey(file: string): Promise<Key> {
	const text = await Bun.file(file).text();
	return Key.parse(text.trim());
}

export function signToken(key: Key, claims: Claims): Promise<string> {
	return Key.sign(key, claims);
}
