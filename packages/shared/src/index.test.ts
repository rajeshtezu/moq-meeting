import { expect, test } from "bun:test";
import { isValidId, randomId, roomPath } from "./index";

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
