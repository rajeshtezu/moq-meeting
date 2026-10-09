/**
 * A tiny UDP network emulator in front of the dev relay, for congestion tests without
 * touching system network settings. Point one browser tab at it with `?relayPort=4444`;
 * other tabs keep talking to the relay directly.
 *
 *   bun scripts/netem.ts --down 1000 --loss 5 --delay 40       # 1 Mbps down, 5% loss, +40 ms
 *   bun scripts/netem.ts --up 400                               # 400 kbps uplink
 *
 * Flags (per direction; "down" is relay → browser):
 *   --listen <port>   proxy port (default 4444); forwards to --relay (default 4443)
 *   --down/--up <kbps>  bottleneck rate, 0 = unlimited (default 0)
 *   --loss <pct>      random loss, both directions (default 0)
 *   --delay <ms>      one-way delay added in each direction (default 0)
 *   --queue <ms>      bottleneck buffer; packets that would wait longer are dropped (default 200)
 *
 * QUIC/WebTransport only (UDP); the WebSocket fallback isn't proxied.
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		listen: { type: "string", default: "4444" },
		relay: { type: "string", default: "4443" },
		down: { type: "string", default: "0" },
		up: { type: "string", default: "0" },
		loss: { type: "string", default: "0" },
		delay: { type: "string", default: "0" },
		queue: { type: "string", default: "200" },
	},
});

const num = (v: string | undefined) => Number(v ?? 0);

/** One direction of the link: random loss, then a rate-limited FIFO with tail drop, then delay. */
class Link {
	#nextFree = 0;
	stats = { packets: 0, bytes: 0, lost: 0, queueDrops: 0 };

	constructor(
		readonly name: string,
		readonly kbps: number,
		readonly lossPct: number,
		readonly delayMs: number,
		readonly queueMs: number,
	) {}

	send(packet: Uint8Array, deliver: (p: Uint8Array) => void) {
		if (Math.random() * 100 < this.lossPct) {
			this.stats.lost++;
			return;
		}
		const now = performance.now();
		let departure = now;
		if (this.kbps > 0) {
			const serialization = (packet.byteLength * 8) / this.kbps; // ms
			departure = Math.max(now, this.#nextFree) + serialization;
			if (departure - now > this.queueMs) {
				this.stats.queueDrops++;
				return;
			}
			this.#nextFree = departure;
		}
		this.stats.packets++;
		this.stats.bytes += packet.byteLength;
		const wait = departure - now + this.delayMs;
		// Copy: the socket may reuse its receive buffer.
		const copy = packet.slice();
		if (wait < 0.5) deliver(copy);
		else setTimeout(() => deliver(copy), wait);
	}

	report(seconds: number): string {
		const s = this.stats;
		const kbps = Math.round((s.bytes * 8) / 1000 / seconds);
		this.stats = { packets: 0, bytes: 0, lost: 0, queueDrops: 0 };
		return `${this.name} ${String(kbps).padStart(5)} kbps, ${s.packets} pkts, lost ${s.lost}, queue-drop ${s.queueDrops}`;
	}
}

const loss = num(values.loss);
const delay = num(values.delay);
const queue = num(values.queue);
const down = new Link("down", num(values.down), loss, delay, queue);
const up = new Link("up  ", num(values.up), loss, delay, queue);
const relayPort = num(values.relay);
const listenPort = num(values.listen);

type Client = { send: (p: Uint8Array) => void };
const clients = new Map<string, Promise<Client>>();

/** One upstream socket per browser 5-tuple, so the relay sees distinct connections. */
function upstreamFor(key: string, reply: (p: Uint8Array) => void): Promise<Client> {
	let client = clients.get(key);
	if (!client) {
		client = Bun.udpSocket({
			connect: { hostname: "127.0.0.1", port: relayPort },
			socket: { data: (_s, buf) => down.send(buf, reply) },
		}).then((sock) => ({ send: (p: Uint8Array) => void sock.send(p) }));
		clients.set(key, client);
	}
	return client;
}

// Browsers may resolve "localhost" to either family, so listen on both.
for (const hostname of ["127.0.0.1", "::1"]) {
	const listener = await Bun.udpSocket({
		hostname,
		port: listenPort,
		socket: {
			data(socket, buf, port, addr) {
				const key = `${addr}:${port}`;
				void upstreamFor(key, (p) => void socket.send(p, port, addr)).then((c) => up.send(buf, c.send));
			},
		},
	});
	console.log(`netem listening on ${hostname}:${listener.port} → relay :${relayPort}`);
}

const fmt = (k: number) => (k > 0 ? `${k} kbps` : "unlimited");
console.log(`down ${fmt(down.kbps)}, up ${fmt(up.kbps)}, loss ${loss}%, delay +${delay} ms, queue ${queue} ms`);

const REPORT_S = 5;
setInterval(() => {
	console.log(`[netem] ${down.report(REPORT_S)} | ${up.report(REPORT_S)} | clients ${clients.size}`);
}, REPORT_S * 1000);
