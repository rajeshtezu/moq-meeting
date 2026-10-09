# MoQ library notes (Phase 0 spike)

What we actually found using the pinned versions, as opposed to what the docs suggested.
Update this as the libraries change.

## Versions (pinned)

| Package / binary | Version | Notes |
|---|---|---|
| `@moq/net` | 0.4.2 | Peer deps `zod` / `@zod/mini` ^4.5 must be installed explicitly |
| `@moq/hang` | 0.5.2 | Not used yet (Phase 1). Subpath exports: `/catalog`, `/container`, `/util` |
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
