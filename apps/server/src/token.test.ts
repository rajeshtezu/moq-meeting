import { describe, expect, test } from "bun:test";
import { Key } from "@moq/auth";
import { participantClaims, signToken } from "./token";

describe("participantClaims", () => {
	const claims = participantClaims("room123abc", "alice12345", 1_000, 3_600);

	test("scopes the token to the room", () => {
		expect(claims.root).toBe("rooms/room123abc");
	});

	test("publishes only the participant's own broadcasts", () => {
		expect(claims.publish).toEqual(["alice12345/**"]);
	});

	test("subscribes to everything in the room", () => {
		expect(claims.subscribe).toEqual(["**"]);
	});

	test("sets issue and expiry times", () => {
		expect(claims.iat).toBe(1_000);
		expect(claims.exp).toBe(4_600);
	});

	test("contains no claims the relay would refuse", () => {
		expect(Object.keys(claims).sort()).toEqual(["exp", "iat", "publish", "root", "subscribe"]);
	});
});

test("signed token verifies with the public key", async () => {
	const key = await Key.generate("ES256");
	const now = Math.floor(Date.now() / 1000);
	const token = await signToken(key, participantClaims("room123abc", "alice12345", now, 60));
	const verified = await Key.verify(Key.public(key), token);
	expect(verified.root).toBe("rooms/room123abc");
	expect(verified.publish).toEqual(["alice12345/**"]);
});
