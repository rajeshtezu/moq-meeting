import { Catalog } from "@moq/hang";
import * as Json from "@moq/json";
import * as Moq from "@moq/net";
import {
	type ChatMessage,
	MAX_CHAT_LENGTH,
	type Presence,
	parseChat,
	parsePresence,
	type TokenResponse,
	Tracks,
} from "@moq-meeting/shared";
import { AudioPublisher } from "../media/audio-publisher";
import { CatalogPublisher } from "../media/catalog";
import { MediaClock } from "../media/clock";
import { type NetworkSignals, SCREEN, VideoPublisher } from "../media/video-publisher";

/**
 * Thin adapter around `@moq/net` for one room session. Everything the app does with MoQ
 * goes through here, so library API churn stays contained in this folder.
 *
 * Each participant publishes one broadcast at `<participantId>` holding `catalog.json`,
 * `video`, `audio`, `presence` (name + mic/cam state as a JSON snapshot), and `chat`
 * (a lossless JSON stream: one group for the whole session, so late joiners get history).
 * A screen share is a second broadcast at `<participantId>/screen` (catalog + video), which
 * the token's `<participantId>/**` grant covers; peers learn of it from its announcement.
 * Other participants are discovered from announcements; the UI subscribes to their media
 * through {@link RoomSession.peer}.
 */

export interface SessionEvents {
	onPeerJoined(participantId: string): void;
	onPeerLeft(participantId: string): void;
	/** A chat message from a peer (including history on join). `from` is their participant ID. */
	onChat?(from: string, message: ChatMessage): void;
	/** A peer started (`true`) or stopped (`false`) sharing their screen. */
	onScreen?(participantId: string, sharing: boolean): void;
	/** Connection state changes after joining; the session reconnects on its own. */
	onStatus?(status: ConnectionStatus): void;
	/** A peer's latest presence; late joiners get the current value immediately. */
	onPresence?(participantId: string, presence: Presence): void;
	onClosed(error?: Error): void;
}

function devWebSocketUrl(relayUrl: string): URL {
	const url = new URL(relayUrl);
	url.protocol = "ws:";
	return url;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** Below audio/video: chat can wait a few ms under congestion; the log itself is lossless. */
const CHAT_PRIORITY = 40;
const CHAT_RATE = { max: 5, windowMs: 2000 };

interface Peer {
	request: Moq.Origin.Requesting;
	tracks: Moq.Track.Subscriber[];
}

export class RoomSession {
	readonly participantId: string;
	readonly name: string;

	#origin = new Moq.Origin.Producer();
	#connection: Moq.Connection | undefined;
	readonly #effect = new Moq.Signals.Effect();
	#broadcast: Moq.Broadcast.Producer | undefined;
	#chatTrack: Moq.Track.Producer | undefined;
	#chat: Json.Stream.Producer<ChatMessage> | undefined;
	#chatSeq = 0;
	#chatSent: number[] = [];
	#publishers: { close(): void }[] = [];
	#video: VideoPublisher | undefined;
	#audio: AudioPublisher | undefined;
	#presenceTrack: Moq.Track.Producer | undefined;
	#presenceProducer: Json.Snapshot.Producer<Presence> | undefined;
	#presence: Presence;
	readonly clock = new MediaClock();
	#peers = new Map<string, Peer>();
	#screens = new Map<string, Moq.Origin.Requesting>();
	#myScreen: { broadcast: Moq.Broadcast.Producer; publishers: { close(): void }[] } | undefined;
	#events: SessionEvents;
	#closed = false;

	private constructor(token: TokenResponse, events: SessionEvents) {
		this.participantId = token.participantId;
		this.name = token.name;
		this.#events = events;
		this.#presence = { name: token.name, mic: false, cam: false };
	}

	/** Join the room, publishing `media` (camera/mic or test source) if given. */
	static async join(token: TokenResponse, events: SessionEvents, media?: MediaStream): Promise<RoomSession> {
		const session = new RoomSession(token, events);
		await session.#connect(token, media);
		return session;
	}

	async #connect(token: TokenResponse, media?: MediaStream) {
		const origin = this.#origin;
		// A reconnecting handle: on a network blip or relay restart it redials with backoff,
		// and because the origin is ours, our broadcasts are re-announced on each new session.
		// Peers' broadcasts retract while we're disconnected and reappear after.
		const connection = new Moq.Connection({
			url: new URL(token.relayUrl),
			// One origin for both directions: our broadcast is announced to the relay, and
			// everything the relay announces in this room lands in the same table.
			publish: origin.consume(),
			consume: origin,
			webtransport: token.certificateHash
				? { serverCertificateHashes: [{ algorithm: "sha-256", value: token.certificateHash }] }
				: undefined,
			// Dev relay (self-signed, pinned by hash): a WebSocket can't pin a certificate, so
			// the fallback (Safari, old Firefox, UDP-blocked networks) uses its plain ws:// listener.
			websocket: token.certificateHash ? { url: devWebSocketUrl(token.relayUrl) } : undefined,
		});
		this.#connection = connection;

		// Resolve on the first connect; reject on a fatal error (e.g. auth refused, which
		// stops the reconnect loop). Afterwards, report status changes and close on fatal errors.
		await new Promise<void>((resolve, reject) => {
			let joined = false;
			this.#effect.run((effect) => {
				const status = effect.get(connection.status);
				if (status === "connected" && !joined) {
					joined = true;
					resolve();
				}
				if (joined) this.#events.onStatus?.(status);
			});
			this.#effect.run((effect) => {
				const err = effect.get(connection.error);
				if (!err) return;
				if (joined) this.close(err);
				else reject(err);
			});
		}).catch((err) => {
			this.#effect.close();
			connection.close();
			throw err;
		});

		const broadcast = origin.createBroadcast(Moq.Path.from(this.participantId));
		this.#chatTrack = broadcast.createTrack(Tracks.chat, { priority: CHAT_PRIORITY });
		this.#chat = new Json.Stream.Producer<ChatMessage>({ track: this.#chatTrack, compression: "deflate" });
		this.#presenceTrack = broadcast.createTrack(Tracks.presence, { priority: Catalog.PRIORITY.text });
		this.#presenceProducer = new Json.Snapshot.Producer<Presence>({ track: this.#presenceTrack });
		if (media) this.#publishMedia(broadcast, media);
		this.#presence.mic = !!this.#audio;
		this.#presence.cam = !!this.#video;
		this.#presenceProducer.update(this.#presence);
		broadcast.announce();
		this.#broadcast = broadcast;

		void this.#watchAnnouncements();
	}

	#publishMedia(broadcast: Moq.Broadcast.Producer, media: MediaStream) {
		// The catalog is updated as each encoder reports its decoder config.
		const catalog = new CatalogPublisher(broadcast, this.clock);
		this.#publishers.push(catalog);
		const [video] = media.getVideoTracks();
		if (video) {
			this.#video = new VideoPublisher(
				video,
				broadcast,
				this.clock,
				(r) => catalog.setVideo(r),
				undefined,
				() => this.#network(),
			);
			this.#publishers.push(this.#video);
		}
		const [audio] = media.getAudioTracks();
		if (audio) {
			this.#audio = new AudioPublisher(audio, broadcast, this.clock, (r) => catalog.setAudio(r));
			this.#publishers.push(this.#audio);
		}
	}

	get presence(): Presence {
		return { ...this.#presence };
	}

	/** Mute/unmute: stops sending audio and tells peers via presence. */
	setMic(on: boolean) {
		this.#audio?.setEnabled(on);
		this.#updatePresence({ mic: on });
	}

	/** Camera on/off: stops sending video and tells peers via presence. */
	setCam(on: boolean) {
		this.#video?.setEnabled(on);
		this.#updatePresence({ cam: on });
	}

	#updatePresence(patch: Partial<Presence>) {
		this.#presence = { ...this.#presence, ...patch };
		this.#presenceProducer?.update(this.#presence);
	}

	/** Publish `stream`'s video track as our screen share. Replaces any current share. */
	startScreenShare(stream: MediaStream) {
		this.stopScreenShare();
		const broadcast = this.#origin.createBroadcast(Moq.Path.from(this.participantId, "screen"));
		const catalog = new CatalogPublisher(broadcast, this.clock);
		const publishers: { close(): void }[] = [catalog];
		const [video] = stream.getVideoTracks();
		if (video)
			publishers.push(
				new VideoPublisher(
					video,
					broadcast,
					this.clock,
					(r) => catalog.setVideo(r),
					SCREEN,
					() => this.#network(),
				),
			);
		broadcast.announce();
		this.#myScreen = { broadcast, publishers };
	}

	/** Stop sharing: closing the broadcast retracts its announcement, so peers drop the tile. */
	stopScreenShare() {
		const share = this.#myScreen;
		if (!share) return;
		this.#myScreen = undefined;
		for (const p of share.publishers) p.close();
		share.broadcast.close();
	}

	#network(): NetworkSignals {
		const c = this.#connection;
		return { bandwidth: c?.bandwidth.peek(), rtt: c?.probe.peek()?.rtt };
	}

	/** Transport-level estimates for debugging and ABR: PROBE (relay's view) and send counters. */
	async netStats(): Promise<{ probe: unknown; stats: unknown; bandwidth: boolean }> {
		const c = this.#connection;
		return { probe: c?.probe.peek(), stats: await c?.stats(), bandwidth: !!c?.bandwidth.peek() };
	}

	/** Camera encoder's current target bitrate and its bandwidth grant (bits/s), for the self tile. */
	get sendStats(): { bitrate: number; grant: number | undefined; rtt: number | undefined } | undefined {
		return this.#video ? { ...this.#video.send } : undefined;
	}

	get sharingScreen(): boolean {
		return this.#myScreen !== undefined;
	}

	/** The broadcast request for a peer's screen share, while they are sharing. */
	screen(participantId: string): Moq.Origin.Requesting | undefined {
		return this.#screens.get(participantId);
	}

	/** The broadcast request for a discovered participant, for subscribing to their media. */
	peer(participantId: string): Moq.Origin.Requesting | undefined {
		return this.#peers.get(participantId)?.request;
	}

	/** Transport actually in use; WebSocket means we fell back from WebTransport. */
	get transport(): string {
		return this.#connection?.transport.peek() ?? "unknown";
	}

	/**
	 * Send a chat message; returns it for local echo. Throws if empty or over the rate limit
	 * (the log is lossless and never rolls, so it's throttled at the source).
	 */
	sendChat(text: string): ChatMessage {
		if (!this.#chat) throw new Error("not connected");
		const trimmed = text.trim().slice(0, MAX_CHAT_LENGTH);
		if (!trimmed) throw new Error("empty message");
		const now = Date.now();
		this.#chatSent = this.#chatSent.filter((t) => now - t < CHAT_RATE.windowMs);
		if (this.#chatSent.length >= CHAT_RATE.max) throw new Error("slow down: too many messages");
		this.#chatSent.push(now);

		const message: ChatMessage = { id: ++this.#chatSeq, text: trimmed, sentAt: now };
		this.#chat.append(message);
		return message;
	}

	async #watchAnnouncements() {
		for await (const update of this.#origin.consume().announced()) {
			const path = update.prefix as string;
			const [id, kind, ...rest] = path.split("/");
			if (!id || id === this.participantId || rest.length) continue;
			if (kind === "screen") {
				this.#onScreenAnnounce(id, path, Moq.Announce.isActive(update.kind));
				continue;
			}
			if (kind !== undefined) continue;

			if (Moq.Announce.isActive(update.kind)) {
				if (!this.#peers.has(id)) this.#addPeer(id);
			} else {
				this.#removePeer(id);
			}
		}
	}

	#onScreenAnnounce(id: string, path: string, active: boolean) {
		const existing = this.#screens.get(id);
		if (active && !existing) {
			this.#screens.set(id, this.#origin.request(Moq.Path.from(path), { announced: true }));
			this.#events.onScreen?.(id, true);
		} else if (!active && existing) {
			this.#screens.delete(id);
			existing.close();
			this.#events.onScreen?.(id, false);
		}
	}

	#addPeer(id: string) {
		const request = this.#origin.request(Moq.Path.from(id), { announced: true });
		const peer: Peer = { request, tracks: [] };
		this.#peers.set(id, peer);
		this.#events.onPeerJoined(id);

		void (async () => {
			let active = request.active.peek();
			while (!active) {
				await request.active.changed();
				if (!this.#peers.has(id)) return;
				active = request.active.peek();
			}
			void this.#readPresence(id, peer, active);
			void this.#readChat(id, peer, active);
		})();
	}

	async #readPresence(id: string, peer: Peer, broadcast: Moq.Broadcast.Consumer) {
		const track = broadcast.track(Tracks.presence).subscribe({ priority: Catalog.PRIORITY.text });
		peer.tracks.push(track);
		try {
			for await (const value of new Json.Snapshot.Consumer<unknown>({ track })) {
				const presence = parsePresence(value);
				if (presence && this.#peers.has(id)) this.#events.onPresence?.(id, presence);
			}
		} catch (err) {
			if (this.#peers.has(id)) console.warn("presence track ended", id, err);
		}
	}

	async #readChat(id: string, peer: Peer, broadcast: Moq.Broadcast.Consumer) {
		const track = broadcast.track(Tracks.chat).subscribe({ priority: CHAT_PRIORITY });
		peer.tracks.push(track);
		try {
			for await (const value of new Json.Stream.Consumer<unknown>({ track, compression: "deflate" })) {
				const message = parseChat(value);
				if (message && this.#peers.has(id)) this.#events.onChat?.(id, message);
			}
		} catch (err) {
			if (this.#peers.has(id)) console.warn("chat track ended", id, err);
		}
	}

	#removePeer(id: string) {
		const peer = this.#peers.get(id);
		if (!peer) return;
		this.#peers.delete(id);
		for (const t of peer.tracks) t.close();
		peer.request.close();
		this.#events.onPeerLeft(id);
	}

	close(error?: Error) {
		if (this.#closed) return;
		this.#closed = true;
		for (const id of [...this.#peers.keys()]) this.#removePeer(id);
		for (const r of this.#screens.values()) r.close();
		this.#screens.clear();
		this.stopScreenShare();
		for (const p of this.#publishers) p.close();
		this.#presenceProducer?.finish();
		this.#presenceTrack?.close();
		this.#chat?.finish();
		this.#chatTrack?.close();
		this.#broadcast?.close();
		this.#effect.close();
		this.#connection?.close();
		this.#origin.close();
		this.#events.onClosed(error);
	}
}
