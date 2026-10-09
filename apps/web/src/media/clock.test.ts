import { expect, test } from "bun:test";
import { Catalog } from "@moq/hang";
import { fromHex, toHex } from "./catalog";
import { MediaClock, Rebase, wallTimeMs } from "./clock";

test("catalog clock maps pts 0 to the session start", () => {
	const clock = new MediaClock();
	const startWall = wallTimeMs(clock.catalog, 0);
	expect(Math.abs(startWall - Date.now())).toBeLessThan(50);
	expect(clock.catalog.wall).toBeGreaterThan(0);
	expect(startWall).toBeGreaterThan(Catalog.MOQ_EPOCH_UNIX_MILLIS);
});

test("wallTimeMs advances 1 ms per 1000 µs of pts", () => {
	const clock = { wall: 1_000, timescale: 1000 };
	expect(wallTimeMs(clock, 2_500_000) - wallTimeMs(clock, 0)).toBe(2_500);
});

test("Rebase fixes the offset at the first sample and keeps spacing", () => {
	const rebase = new Rebase(new MediaClock());
	const a = rebase.apply(10_000_000);
	const b = rebase.apply(10_033_333);
	expect(b - a).toBe(33_333);
	expect(a).toBeLessThan(100_000); // session clock just started
});

test("hex round-trip for decoder descriptions", () => {
	const bytes = new Uint8Array([0x01, 0x64, 0x00, 0x1f, 0xff]);
	expect(toHex(bytes)).toBe("0164001fff");
	expect(fromHex("0164001fff")).toEqual(bytes);
	expect(toHex(bytes.buffer)).toBe("0164001fff");
	expect(toHex(undefined)).toBeUndefined();
	expect(fromHex(undefined)).toBeUndefined();
});
