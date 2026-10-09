import { expect, test } from "bun:test";
import { RateController } from "./rate";

const opts = { min: 150_000, max: 800_000 };

test("starts at the ceiling and holds without signals", () => {
	const rc = new RateController(opts);
	expect(rc.target).toBe(800_000);
	expect(rc.update({})).toBe(800_000);
});

test("follows an allocator grant with 10% headroom, clamped", () => {
	const rc = new RateController(opts);
	expect(rc.update({ grant: 500_000 })).toBe(450_000);
	expect(rc.update({ grant: 50_000 })).toBe(150_000);
	expect(rc.update({ grant: 5_000_000 })).toBe(800_000);
});

test("backs off when RTT stays above its minimum (queueing), down to the floor", () => {
	const rc = new RateController(opts);
	rc.update({ rtt: 20 });
	rc.update({ rtt: 20 });
	expect(rc.update({ rtt: 150 })).toBe(800_000); // one spike: median still 20
	expect(rc.update({ rtt: 160 })).toBe(600_000); // sustained: back off
	expect(rc.update({ rtt: 170 })).toBe(600_000); // let the queue drain a tick
	expect(rc.update({ rtt: 170 })).toBe(450_000);
	for (let i = 0; i < 10; i++) rc.update({ rtt: 200 });
	expect(rc.target).toBe(150_000);
});

test("holds after a decrease, then recovers gradually once RTT is back near the minimum", () => {
	const rc = new RateController(opts);
	rc.update({ rtt: 20 });
	rc.update({ rtt: 150 });
	rc.update({ rtt: 150 }); // → 600k
	expect(rc.update({ rtt: 22 })).toBe(600_000); // median still 150, but just cut: no second cut
	expect(rc.update({ rtt: 22 })).toBe(600_000); // queue gone, holding
	expect(rc.update({ rtt: 22 })).toBe(600_000);
	expect(rc.update({ rtt: 22 })).toBe(648_000); // hold over: +8%
	for (let i = 0; i < 20; i++) rc.update({ rtt: 22 });
	expect(rc.target).toBe(800_000);
});

test("RTT between the clear and queueing bands neither increases nor decreases", () => {
	const rc = new RateController(opts);
	rc.update({ rtt: 20 });
	rc.update({ rtt: 150 });
	rc.update({ rtt: 150 }); // 600k
	for (let i = 0; i < 5; i++) rc.update({ rtt: 70 }); // +50 ms: ambiguous
	expect(rc.target).toBe(600_000);
});

test("an RTT above the absolute ceiling backs off even when the window minimum is inflated", () => {
	const rc = new RateController(opts);
	// Joined an already-congested link: every sample is high, so no rise above the minimum.
	expect(rc.update({ rtt: 350 })).toBe(600_000);
	expect(rc.update({ rtt: 340 })).toBe(600_000);
	expect(rc.update({ rtt: 345 })).toBe(450_000);
	// A merely long path (high but stable, under the ceiling) doesn't.
	const far = new RateController(opts);
	for (let i = 0; i < 5; i++) far.update({ rtt: 250 });
	expect(far.target).toBe(800_000);
});

test("isolated spikes on a clean link never cut the bitrate", () => {
	const rc = new RateController(opts);
	const noisy = [5, 4, 79, 6, 3, 60, 8, 4, 70, 5, 3, 11];
	for (const rtt of noisy) rc.update({ rtt });
	expect(rc.target).toBe(800_000);
});
