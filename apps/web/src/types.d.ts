// Chrome-only Insertable Streams API, not yet in TypeScript's DOM lib.
interface MediaStreamTrackProcessorInit {
	track: MediaStreamTrack;
	maxBufferSize?: number;
}

declare class MediaStreamTrackProcessor<T extends VideoFrame | AudioData = VideoFrame | AudioData> {
	constructor(init: MediaStreamTrackProcessorInit);
	readonly readable: ReadableStream<T>;
}
