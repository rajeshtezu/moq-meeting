import { Catalog } from "@moq/hang";

/**
 * One timebase for everything a participant publishes: microseconds since the session
 * started. Audio and video capture clocks are rebased onto it so their timestamps are
 * comparable, and the catalog advertises its wall-clock origin so receivers can measure
 * end-to-end latency (`Date.now()` minus a frame's wall time).
 */
export class MediaClock {
	readonly #origin = performance.now();

	/** Catalog `clock`: wall time of PTS 0, in ms since the MoQ epoch. */
	readonly catalog = {
		wall: Math.round(performance.timeOrigin + this.#origin - Catalog.MOQ_EPOCH_UNIX_MILLIS),
		timescale: 1000,
	};

	nowMicros(): number {
		return Math.round((performance.now() - this.#origin) * 1000);
	}
}

/** Wall-clock time (Unix ms) of a frame timestamp, using a peer's advertised catalog clock. */
export function wallTimeMs(clock: { wall: number; timescale: number }, ptsMicros: number): number {
	return Catalog.MOQ_EPOCH_UNIX_MILLIS + (clock.wall * 1000) / clock.timescale + ptsMicros / 1000;
}

/**
 * Rebases a capture clock onto the session clock. The offset is fixed at the first frame,
 * so the capture clock's own spacing (and thus smooth audio) is preserved.
 */
export class Rebase {
	#offset: number | undefined;
	constructor(readonly clock: MediaClock) {}

	apply(captureMicros: number): number {
		this.#offset ??= this.clock.nowMicros() - captureMicros;
		return captureMicros + this.#offset;
	}
}
