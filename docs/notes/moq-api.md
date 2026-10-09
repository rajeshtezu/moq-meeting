# MoQ library notes (Phase 0 spike)

What we actually found using the pinned versions, as opposed to what the docs suggested.
Update this as the libraries change.

## Versions (pinned)

| Package / binary | Version | Notes |
|---|---|---|
| `@moq/net` | 0.4.2 | Peer deps `zod` / `@zod/mini` ^4.5 must be installed explicitly |
| `@moq/hang` | 0.5.2 | Catalog, legacy container, consumer buffer |
| `@moq/json` | 0.4.2 | Snapshot (catalog, later presence) / Stream (later chat) |
| `tailwindcss` via `bun-plugin-tailwind` | 0.1.2 | `bunfig.toml` for dev; `scripts/build.ts` passes the plugin for prod |
| `@moq/auth` | 0.2.2 | Wraps `jose` |
| `moq-relay` | 0.17.x | Homebrew `moq-dev/tap/moq-relay`, apt `moq-relay`, crate `moq-relay` |
| `moq` CLI | 0.14.x | Formerly `moq-cli` (still the crate name). Provides `moq auth …` |
| Bun | 1.4.2 | |

Negotiated protocol in the spike: **`moq-lite-06`**.

## `@moq/net`

```ts
import * as Moq from "@moq/net";

const origin = new Moq.Origin.Producer();
const conn = await Moq.Connection.connect({
  url: new URL(`${relay}/rooms/${roomId}?jwt=${token}`),
  publish: origin.consume(),   // what we announce + serve
  consume: origin,             // where the relay's announcements land
  webtransport: { serverCertificateHashes: [{ algorithm: "sha-256", value: hexFingerprint }] }, // dev only
});
conn.transport;                // "webtransport" | "websocket"

// Publish
const bc = origin.createBroadcast(Moq.Path.from(participantId));
const track = bc.createTrack("hello", { timescale: Moq.Time.Timescale.MILLI });
bc.announce();
const g = track.appendGroup(); g.writeString("hi"); g.close();   // or g.writeFrame({ payload, timestamp })

// Discover. Our own broadcast shows up too, so filter it out.
for await (const u of origin.consume().announced()) {
  Moq.Announce.isActive(u.kind);   // "announced" | "updated" → true, "retracted" → false
  u.prefix;                        // path relative to the connection URL, i.e. the participantId
}

// Subscribe
const req = origin.request(Moq.Path.from(id), { announced: true });
// req.active is a Getter: .peek() / await .changed()
const sub = active.track("hello").subscribe({ priority: 0 /*, maxAge */ });
const group = await sub.recvGroup();     // undefined when the track ends
const text = await group.readString();   // or readFrame()
```

Findings:
- **Paths are relative to the connection URL.** Dialing `/rooms/<id>` means broadcasts are just `<participantId>`, and the relay logs them as `rooms/<id>/<participantId>`.
- **Late subscribers start at the latest group.** For data tracks where history matters (chat), either keep one long group per session (hang JSON "stream" mode) or replay on join.
- `Moq.Connection.connect` is one-shot. `new Moq.Connection({...})` is the reconnecting, pooled handle, which uses a private loop when pinning a cert. Consider switching to it in Phase 1 for automatic reconnect.
- The library logs verbosely to `console` (`subscribe ok`, `announced: …`). Hasn't been a problem so far; look for a log-level knob later.
- In Bun (no WebTransport) the connection automatically uses the WebSocket fallback (`https` → `wss`, `http` → `ws`).

## Auth

- `Key.parse(text)` accepts the base64url JWK files `moq auth generate` writes. `Key.public(key)` derives the verify half.
- **`<id>/**` already covers `<id>`**, and the library reduces `["<id>", "<id>/**"]` to `["<id>/**"]`. Use the single pattern.
- The relay refuses tokens with unknown claims (`aud` etc.). Stick to `root`, `publish`, `subscribe`, `iat`, `exp`.
- Verified in the smoke test: a token for room A is refused on `/rooms/B`, and publishing under another participant's ID never gets announced to others.

## Relay (dev)

- `tls.generate = ["localhost"]` + `[web.http]` on the same port: `/certificate.sha256` returns the hex fingerprint, which the Bun server fetches and hands to the client.
- Harmless warning at startup: `accept failed … listener="web" err=invalid input parameter`. The listener retries and serves fine.

## `@moq/hang` (Phase 1)

```ts
import { Catalog, Container } from "@moq/hang";

// Publish: Legacy.Producer opens a new group on every keyframe (= one GoP per group).
const track = broadcast.createTrack("video", Container.trackInfo({ priority: Catalog.PRIORITY.video }));
const producer = new Container.Legacy.Producer(track, new Container.Legacy.Format("video"));
producer.encode(encodedChunk, Time.Micro(pts), chunk.type === "key");   // first frame must be a keyframe

// Catalog: must be written with @moq/json Snapshot, because Catalog.watch reads it with Json.Snapshot.Consumer.
const catalog = new Json.Snapshot.Producer({ track: broadcast.createTrack(Catalog.TRACK, { priority: Catalog.PRIORITY.catalog }) });
catalog.update({ video: { renditions: { video: {...} } }, audio: {...}, clock: { wall, timescale: 1000 } });

// Subscribe
for await (const root of Catalog.watch(broadcastConsumer)) { /* root.video.renditions, root.clock */ }
const sub = broadcastConsumer.track("video").subscribe({ priority: Catalog.PRIORITY.video, maxAge: Time.Milli(500) });
const consumer = new Container.Consumer(sub, { format: new Container.Legacy.Format(config), maxAge: Time.Milli(500) });
const next = await consumer.next();   // { frame?: { payload, timestamp, keyframe }, group, continuous, ... }
```

Findings:
- **The rendition key is the track name** (`renditions: { video: {...} }` means subscribe to track `video`), matching `@moq/watch`.
- `PRIORITY` = catalog 100, text 90, audio 80, video 60. Used as-is.
- H.264 with `avc: { format: "annexb" }` puts SPS/PPS inline in every keyframe, so the catalog needs no `description` and late joiners decode from any group. `@moq/publish` does the same.
- `next.continuous === false` (a skipped group or a playhead jump) means waiting for the next keyframe before decoding again.
- **Timestamps:** capture clocks are rebased onto one session clock (µs since join), and the catalog `clock.wall` gives PTS 0's wall time, so receivers measure latency as `Date.now() - wall(pts)`. The offset is pinned when the first frame is *read* from `MediaStreamTrackProcessor`, but that frame may have sat in the processor's queue, so the meter reads up to about one frame low (we saw −15 to −35 ms on localhost). Good enough for a POC. A tighter anchor would need capture timestamps on a known clock.
- `canvas.captureStream()` frames start at timestamp 0. A camera's start time is arbitrary too, so always rebase.
- Main-thread timers and rAF are throttled in background tabs, so the test pattern ticks from a Worker to keep multi-tab tests smooth.
- Bun HMR doesn't hot-swap these modules, so editing media code triggers a full reload of every open tab (and they leave the room).

## Audio playout

- Like `@moq/watch`: decoded PCM goes to an AudioWorklet jitter buffer, then to `AudioContext.destination` (48 kHz). The buffer starts at 60 ms, and when it exceeds 200 ms it skips back to 80 ms.
- The AudioContext is created inside the Join click (autoplay policy).
- Echo cancellation relies on Chrome's tab-wide AEC covering Web Audio output. **Not yet verified with real speakers.**

## Presence and pausing (Phase 2)

- `presence` is a `@moq/json` `Snapshot.Producer<Presence>`. `update()` is a no-op when the value is unchanged, and a late subscriber's `Snapshot.Consumer` yields the current value first, so "late joiners see current state" needs no extra code.
- Presence from peers is validated with `parsePresence` (`packages/shared`), because peers are untrusted.
- **Pausing a media track:**
  - disable the `MediaStreamTrack` (Chrome turns the camera light off, and the processor keeps yielding black or silent frames, which we drop)
  - `encoder.flush()`
  - `Legacy.Producer.cut()`, so subscribers see a clean break instead of the last group reading as live
  - on resume, force a keyframe (video) or start a new group (audio)
- The receiver needs no changes: after the cut, `Container.Consumer.next()` reports `continuous: false` and the decoder waits for the keyframe.
- Speaking detection: RMS of decoded PCM (peers) or `AnalyserNode` time-domain data (self), threshold ≈ 0.008 (−42 dBFS), 400 ms hold.
- Testing gotcha: the in-app browser's screenshots sometimes show a `<video>` preview as black after switching tabs, even though it's playing (pixels read back fine). It's a capture artifact, not an app bug.

## Chat (Phase 3)

- `@moq/json` `Stream.Producer` / `Stream.Consumer`: a lossless append log in **one group that never rolls**. A late subscriber starts at the latest group, which is the whole log, so history comes for free from the relay cache. Producer and consumer must agree on `compression` (we use `"deflate"`, which compresses each record against the earlier ones).
- A second group on a stream track makes the consumer throw `Rolled` (a broken publisher). There's no catch-up machinery, so throttle at the source.
- Sender = broadcast path. Never trust a name or ID inside the record.

## Dev server gotcha

- After many edits to a module, Bun's dev bundler once served a bundle with **both** the old and new copies of `session.ts` (a removed method was still present and a new one was "not a function"). Restarting `bun run dev` fixed it. If behavior doesn't match the source, restart before debugging.
