import * as Moq from "@moq/net";
import { type TokenResponse, Tracks } from "@moq-meeting/shared";
import { AudioPublisher } from "../media/audio-publisher";
import { CatalogPublisher } from "../media/catalog";
import { MediaClock } from "../media/clock";
import { VideoPublisher } from "../media/video-publisher";

/**
 * Thin adapter around `@moq/net` for one room session. Everything the app does with MoQ
 * goes through here, so library API churn stays contained in this folder.
 *
 * Each participant publishes one broadcast at `<participantId>` holding `catalog.json`,
 * `video`, `audio`, and the Phase 0 `hello` text track (kept for the headless smoke test).
 * Other participants are discovered from announcements; the UI subscribes to their media
 * through {@link RoomSession.peer}.
 */

export interface HelloMessage {
	from: string;
	name: string;
	text: string;
	sentAt: number;
}

export interface SessionEvents {
	onPeerJoined(participantId: string): void;
	onPeerLeft(participantId: string): void;
	onMessage(message: HelloMessage): void;
	onClosed(error?: Error): void;
}

export class RoomSession {
	readonly participantId: string;
	readonly name: string;

	#origin = new Moq.Origin.Producer();
	#connection: Moq.Connection.Established | undefined;
	#broadcast: Moq.Broadcast.Producer | undefined;
	#hello: Moq.Track.Producer | undefined;
	#publishers: { close(): void }[] = [];
	readonly clock = new MediaClock();
	#peers = new Map<string, { request: Moq.Origin.Requesting; subscriber?: Moq.Track.Subscriber }>();
	#events: SessionEvents;
	#closed = false;

	private constructor(token: TokenResponse, events: SessionEvents) {
		this.participantId = token.participantId;
		this.name = token.name;
		this.#events = events;
	}

	/** Join the room, publishing `media` (camera/mic or test source) if given. */
	static async join(token: TokenResponse, events: SessionEvents, media?: MediaStream): Promise<RoomSession> {
		const session = new RoomSession(token, events);
		await session.#connect(token, media);
		return session;
	}

	async #connect(token: TokenResponse, media?: MediaStream) {
		const origin = this.#origin;
		this.#connection = await Moq.Connection.connect({
			url: new URL(token.relayUrl),
			// One origin for both directions: our broadcast is announced to the relay, and
			// everything the relay announces in this room lands in the same table.
			publish: origin.consume(),
			consume: origin,
			webtransport: token.certificateHash
				? { serverCertificateHashes: [{ algorithm: "sha-256", value: token.certificateHash }] }
				: undefined,
		});

		const broadcast = origin.createBroadcast(Moq.Path.from(this.participantId));
		this.#hello = broadcast.createTrack(Tracks.hello, { timescale: Moq.Time.Timescale.MILLI });
		if (media) this.#publishMedia(broadcast, media);
		broadcast.announce();
		this.#broadcast = broadcast;

		void this.#watchAnnouncements();
		void this.#connection.closed.then((err) => this.close(err ?? undefined));
	}

	#publishMedia(broadcast: Moq.Broadcast.Producer, media: MediaStream) {
		// The catalog is updated as each encoder reports its decoder config.
		const catalog = new CatalogPublisher(broadcast, this.clock);
		this.#publishers.push(catalog);
		const [video] = media.getVideoTracks();
		if (video) this.#publishers.push(new VideoPublisher(video, broadcast, this.clock, (r) => catalog.setVideo(r)));
		const [audio] = media.getAudioTracks();
		if (audio) this.#publishers.push(new AudioPublisher(audio, broadcast, this.clock, (r) => catalog.setAudio(r)));
	}

	/** The broadcast request for a discovered participant, for subscribing to their media. */
	peer(participantId: string): Moq.Origin.Requesting | undefined {
		return this.#peers.get(participantId)?.request;
	}

	/** Transport actually in use; WebSocket means we fell back from WebTransport. */
	get transport(): string {
		return this.#connection?.transport ?? "unknown";
	}

	send(text: string) {
		if (!this.#hello) throw new Error("not connected");
		const message: HelloMessage = { from: this.participantId, name: this.name, text, sentAt: Date.now() };
		// One message per group: a late subscriber starts at the latest group, and nothing
		// later waits behind an earlier message.
		const group = this.#hello.appendGroup();
		group.writeString(JSON.stringify(message));
		group.close();
	}

	async #watchAnnouncements() {
		for await (const update of this.#origin.consume().announced()) {
			const id = update.prefix as string;
			if (id === this.participantId || id.includes("/")) continue;

			if (Moq.Announce.isActive(update.kind)) {
				if (!this.#peers.has(id)) this.#addPeer(id);
			} else {
				this.#removePeer(id);
			}
		}
	}

	#addPeer(id: string) {
		const request = this.#origin.request(Moq.Path.from(id), { announced: true });
		const peer: { request: Moq.Origin.Requesting; subscriber?: Moq.Track.Subscriber } = { request };
		this.#peers.set(id, peer);
		this.#events.onPeerJoined(id);

		void (async () => {
			let active = request.active.peek();
			while (!active) {
				await request.active.changed();
				if (!this.#peers.has(id)) return;
				active = request.active.peek();
			}
			const subscriber = active.track(Tracks.hello).subscribe({ priority: 0 });
			peer.subscriber = subscriber;

			for (;;) {
				const group = await subscriber.recvGroup().catch(() => undefined);
				if (!group) break;
				const raw = await group.readString().catch(() => undefined);
				if (!raw) continue;
				try {
					this.#events.onMessage(JSON.parse(raw) as HelloMessage);
				} catch {
					console.warn("ignoring malformed hello frame from", id);
				}
			}
		})();
	}

	#removePeer(id: string) {
		const peer = this.#peers.get(id);
		if (!peer) return;
		this.#peers.delete(id);
		peer.subscriber?.close();
		peer.request.close();
		this.#events.onPeerLeft(id);
	}

	close(error?: Error) {
		if (this.#closed) return;
		this.#closed = true;
		for (const id of [...this.#peers.keys()]) this.#removePeer(id);
		for (const p of this.#publishers) p.close();
		this.#hello?.close();
		this.#broadcast?.close();
		this.#connection?.close();
		this.#origin.close();
		this.#events.onClosed(error);
	}
}
