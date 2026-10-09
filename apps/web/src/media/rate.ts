/**
 * Send-side bitrate controller for one video encoder, ticked once a second.
 *
 * Signals, best first:
 * 1. `grant`: this track's share of the connection's bandwidth estimate (`@moq/net`'s
 *    allocator). Followed directly, with 10% headroom.
 * 2. `rtt`: the relay-measured round trip (PROBE). A queue building at the bottleneck shows
 *    up as RTT rising above its recent minimum, before loss, so it's a delay-based AIMD
 *    controller in the spirit of WebRTC's GCC: back off multiplicatively when queueing
 *    appears, creep up additively-ish when it's gone.
 *
 * Chrome currently reports no send-rate estimate over WebTransport, so (2) is what actually
 * drives it there. It only sees queueing in the network; when the bottleneck is the sender's
 * own uplink, much of the backlog sits in the local QUIC send buffer where RTT can't see it,
 * so this reacts late. Receivers' audio-only fallback (peer-media.ts) is the safety net.
 * See docs/notes/moq-api.md.
 */
export interface RateSignals {
	grant?: number;
	rtt?: number;
}

export interface RateOptions {
	min: number;
	max: number;
	/** RTT this far above the window minimum means a standing queue: decrease. */
	queueingMs?: number;
	/** RTT within this of the minimum means no queue: increase is allowed. */
	clearMs?: number;
	/**
	 * RTT above this always means queueing. Covers joining an already-congested link, where
	 * the window minimum is itself inflated and no rise above it is ever seen.
	 */
	absoluteMs?: number;
	/** How long the RTT minimum is remembered, in ticks (seconds). */
	minWindow?: number;
	/** Ticks to wait after a decrease before increasing again. */
	holdTicks?: number;
}

export class RateController {
	readonly #min: number;
	readonly #max: number;
	readonly #queueingMs: number;
	readonly #clearMs: number;
	readonly #absoluteMs: number;
	readonly #minWindow: number;
	readonly #holdTicks: number;
	#target: number;
	#rtts: number[] = [];
	#tick = 0;
	#lastDecrease = Number.NEGATIVE_INFINITY;

	constructor(options: RateOptions) {
		this.#min = options.min;
		this.#max = options.max;
		this.#queueingMs = options.queueingMs ?? 80;
		this.#clearMs = options.clearMs ?? 30;
		this.#absoluteMs = options.absoluteMs ?? 300;
		this.#minWindow = options.minWindow ?? 30;
		this.#holdTicks = options.holdTicks ?? 3;
		this.#target = options.max;
	}

	get target(): number {
		return this.#target;
	}

	/** Feed one tick of signals; returns the new target bitrate (bits/s). */
	update({ grant, rtt }: RateSignals): number {
		if (grant !== undefined) {
			this.#target = this.#clamp(grant * 0.9);
			return this.#target;
		}
		if (rtt === undefined) return this.#target;

		this.#rtts.push(rtt);
		if (this.#rtts.length > this.#minWindow) this.#rtts.shift();
		const base = Math.min(...this.#rtts);
		// PROBE RTT is noisy (single samples spike by tens of ms on a clean link), so decide
		// on the median of the last three: one spike can't cut the bitrate.
		const recent = this.#rtts.slice(-3).sort((a, b) => a - b);
		const smoothed = recent[Math.floor((recent.length - 1) / 2)] ?? rtt;

		const tick = ++this.#tick;
		const sinceDecrease = tick - this.#lastDecrease;
		if (smoothed > base + this.#queueingMs || smoothed > this.#absoluteMs) {
			// At most every other tick: give the queue a chance to drain before cutting again.
			if (sinceDecrease >= 2) {
				this.#target = this.#clamp(this.#target * 0.75);
				this.#lastDecrease = tick;
			}
		} else if (smoothed < base + this.#clearMs && sinceDecrease > this.#holdTicks) {
			this.#target = this.#clamp(this.#target * 1.08);
		}
		return this.#target;
	}

	#clamp(bps: number): number {
		return Math.round(Math.min(Math.max(bps, this.#min), this.#max));
	}
}
