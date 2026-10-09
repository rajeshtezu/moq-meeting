import { expect, test } from "bun:test";
import { isValidId, MAX_CHAT_LENGTH, parseChat, parsePresence, randomId, roomPath } from "./index";

test("randomId produces valid, distinct ids", () => {
	const ids = new Set(Array.from({ length: 1000 }, () => randomId()));
	expect(ids.size).toBe(1000);
	for (const id of ids) expect(isValidId(id)).toBe(true);
});

test("isValidId rejects path separators and junk", () => {
	for (const bad of ["", "abc", "a/b/cdefg", "../../etc", "has space1", "x".repeat(33)]) {
		expect(isValidId(bad)).toBe(false);
	}
});

test("roomPath", () => {
	expect(roomPath("abc123def")).toBe("rooms/abc123def");
});

test("parsePresence accepts valid values and truncates long names", () => {
	expect(parsePresence({ name: "alice", mic: true, cam: false })).toEqual({ name: "alice", mic: true, cam: false });
	expect(parsePresence({ name: "x".repeat(100), mic: false, cam: false })?.name).toHaveLength(40);
});

test("parsePresence rejects malformed values", () => {
	for (const bad of [null, "alice", 42, {}, { name: 1, mic: true, cam: true }, { name: "a", mic: "yes", cam: true }]) {
		expect(parsePresence(bad)).toBeUndefined();
	}
});

test("parseChat accepts valid records, trims and caps text", () => {
	expect(parseChat({ id: 1, text: "  hi  ", sentAt: 5 })).toEqual({ id: 1, text: "hi", sentAt: 5 });
	expect(parseChat({ id: 2, text: "x".repeat(5000), sentAt: 5 })?.text).toHaveLength(MAX_CHAT_LENGTH);
});

test("parseChat rejects malformed or empty records", () => {
	for (const bad of [
		null,
		"hi",
		{ id: "1", text: "a", sentAt: 1 },
		{ id: 1.5, text: "a", sentAt: 1 },
		{ id: 1, text: "   ", sentAt: 1 },
		{ id: 1, text: "a" },
	]) {
		expect(parseChat(bad)).toBeUndefined();
	}
});
