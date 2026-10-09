import { Catalog } from "@moq/hang";
import * as Json from "@moq/json";
import type * as Moq from "@moq/net";
import { Tracks } from "@moq-meeting/shared";
import type { MediaClock } from "./clock";

/** A video rendition as advertised in the hang catalog (mirrors VideoDecoderConfig). */
export interface VideoRendition {
	codec: string;
	codedWidth: number;
	codedHeight: number;
	framerate?: number;
	bitrate?: number;
	description?: string;
	optimizeForLatency: true;
	container: { kind: "legacy" };
}

/** An audio rendition as advertised in the hang catalog (mirrors AudioDecoderConfig). */
export interface AudioRendition {
	codec: string;
	sampleRate: number;
	numberOfChannels: number;
	bitrate?: number;
	description?: string;
	container: { kind: "legacy" };
}

/** The subset of the hang root catalog we publish. Rendition keys are track names. */
export interface MeetingCatalog {
	video?: { renditions: Record<string, VideoRendition> };
	audio?: { renditions: Record<string, AudioRendition> };
	clock: { wall: number; timescale: number };
}

/** Publishes `catalog.json` as a hang-compatible JSON snapshot track. */
export class CatalogPublisher {
	readonly #producer: Json.Snapshot.Producer<MeetingCatalog>;
	readonly #track: Moq.Track.Producer;

	constructor(broadcast: Moq.Broadcast.Producer, clock: MediaClock) {
		this.#track = broadcast.createTrack(Catalog.TRACK, { priority: Catalog.PRIORITY.catalog });
		this.#producer = new Json.Snapshot.Producer<MeetingCatalog>({
			track: this.#track,
			initial: { clock: clock.catalog },
		});
		this.#producer.update({ clock: clock.catalog });
	}

	setVideo(rendition: VideoRendition | undefined) {
		this.#producer.mutate((c) => {
			if (rendition) c.video = { renditions: { [Tracks.video]: rendition } };
			else delete c.video;
		});
	}

	setAudio(rendition: AudioRendition | undefined) {
		this.#producer.mutate((c) => {
			if (rendition) c.audio = { renditions: { [Tracks.audio]: rendition } };
			else delete c.audio;
		});
	}

	close() {
		this.#producer.finish();
		this.#track.close();
	}
}

export function toHex(buffer: AllowSharedBufferSource | undefined): string | undefined {
	if (!buffer) return undefined;
	const bytes = ArrayBuffer.isView(buffer)
		? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
		: new Uint8Array(buffer);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string | undefined): Uint8Array | undefined {
	if (!hex) return undefined;
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}
