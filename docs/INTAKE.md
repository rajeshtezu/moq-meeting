# MoQ Meeting — POC Intake Document

| Field | Value |
|---|---|
| Project | `moq-meeting` — small browser-based meeting app on Media over QUIC |
| Owner | Rajesh Kumar |
| Status | Approved with defaults (2026-10-09). Phases 0–2 complete. |
| Date | 2026-10-09 |
| References | [doc.moq.dev](https://doc.moq.dev/), [moq-lite concepts](https://doc.moq.dev/concept/moq-lite.html), [hang format](https://doc.moq.dev/concept/hang.html), [relay](https://doc.moq.dev/bin/relay/), [relay auth](https://doc.moq.dev/bin/relay/auth.html), [JS libraries](https://doc.moq.dev/lib/js/), [Bun](https://bun.com/) |

---

## 1. Summary

Build a proof-of-concept meeting app (≤ 8 participants) where every participant publishes camera and mic as a MoQ broadcast and subscribes to everyone else's broadcasts through a relay. The goal is to **learn and validate MoQ as a real-time conferencing transport**, so the media pipeline is built on the **low-level `@moq/net` + `@moq/hang` libraries** instead of the ready-made `<moq-publish>`/`<moq-watch>` elements or `@moq/room`.

Decisions confirmed during intake:

| Topic | Decision |
|---|---|
| Runtime | Bun (server, bundler, package manager, test runner) |
| Relay | Official `moq-relay` (Rust binary), run as-is |
| App server | Bun: serves the React app, room API, and mints room-scoped JWTs |
| MoQ layer | Low-level: `@moq/net` (transport) + `@moq/hang` (catalog/container/codec helpers) |
| Frontend | React + TypeScript, bundled by Bun |
| Scale | ≤ 8 participants per room |
| Auth | JWT per room and participant, verified by the relay |
| Feature delivery | Phased: A/V first, then roster and controls, then chat, then screen share |

## 2. Goals and non-goals

### Goals
- Show sub-second glass-to-glass latency between participants on the same network.
- Show MoQ's congestion behavior in practice: audio stays prioritized over video and stale video groups get dropped instead of piling up as latency.
- Build up hands-on knowledge of broadcasts, tracks, groups, announcements, the catalog, and WebCodecs.
- End up with a clean, small codebase that later work can build on.

### Non-goals (for the POC)
- Production hardening, horizontal scaling, or relay clustering.
- Recording, HLS export, or PSTN/SIP interop.
- WebRTC/WHIP interop.
- End-to-end encryption (traffic is still TLS-encrypted to the relay).
- Mobile-native clients.
- Full Safari/iOS support (see §8).
- Persistent users and accounts. Identity is a display name per session.

## 3. Users and core scenarios

| # | Scenario | Phase |
|---|---|---|
| S1 | User opens `/`, enters a display name, creates a room, and gets a shareable link | 1 |
| S2 | User opens a room link, grants camera and mic, and joins | 1 |
| S3 | Participants see and hear each other in a grid that updates as people join and leave | 1 |
| S4 | User leaves and their tile disappears for everyone else within about 2 s | 1 |
| S5 | Roster shows names plus mic and camera state; user can mute and turn the camera off | 2 |
| S6 | Users send and receive text chat in the room | 3 |
| S7 | User shares their screen, and others see it as a large tile | 4 |

## 4. Architecture

```
┌──────────────────────── Browser (React) ────────────────────────┐
│  getUserMedia ─► WebCodecs Encoders ─► hang container ─┐        │
│                                                        ▼        │
│                                   @moq/net Connection (WebTransport)
│                                                        ▲        │
│  <canvas>/AudioWorklet ◄─ WebCodecs Decoders ◄─ hang ──┘        │
└───────────────┬─────────────────────────────────▲───────────────┘
                │ HTTPS (REST: rooms, token)       │ QUIC / WebTransport
                ▼                                  │ https://localhost:4443/rooms/<id>?jwt=…
┌───────────────────────────┐            ┌─────────┴──────────┐
│ Bun app server (:3000)    │            │ moq-relay (:4443)  │
│ - serves React bundle     │            │ - fan-out, caching │
│ - POST /api/rooms         │            │ - prioritization   │
│ - POST /api/rooms/:id/token ──signs──► │ - [auth] url ──────┼──► moq auth serve (:4440)
│   (ES256, private.jwk)    │            │                    │    (verifies with public.jwk)
└───────────────────────────┘            └────────────────────┘
```

### 4.1 Components

| Component | Tech | Responsibility |
|---|---|---|
| `apps/web` | React 19 + TS, bundled by Bun HTML imports | UI, media capture, encode/decode, MoQ publish and subscribe |
| `apps/server` | `Bun.serve()` | Static and dev serving of the web app, room API, JWT minting |
| `packages/shared` | TS | Shared types: path conventions, track names, chat and presence message schemas |
| `infra/relay` | `moq-relay` + `moq auth serve` | Media relay and token verification. Config lives in `relay.toml` |
| `infra/keys` | JWK files (git-ignored) | `private.jwk` for the Bun server, `public.jwk` for the verifier |

### 4.2 Why the relay is not written in Bun
`@moq/net` can run under Bun, but only over WebSocket, or over QUIC with the native `@moq/web-transport` polyfill. Writing a relay in Bun would be a separate project. The Rust `moq-relay` is the supported path and already handles fan-out, caching, and priority. Bun owns everything else.

## 5. MoQ data model

### 5.1 Path conventions

The connection URL is scoped to the room, so the room path becomes the JWT `root`:

```
Connection URL : https://<relay>/rooms/<roomId>?jwt=<token>
Broadcast      : <participantId>            (camera + mic + presence + chat)
Broadcast      : <participantId>/screen     (phase 4)
```

- `participantId` is a short random ID (e.g. nanoid). The display name travels in the presence track, not the path.
- **Roster discovery** uses `origin.announced(<room prefix>)`. A participant is "in the room" while their broadcast is announced. Leaving or crashing retracts the announcement, which gives S4 for free.

### 5.2 Tracks per participant broadcast

| Track | Content | Group semantics | Priority | Order / max-age | Phase |
|---|---|---|---|---|---|
| `catalog.json` | hang catalog (renditions + decoder config + `clock`), written with `@moq/json` Snapshot | snapshot opens a group, deltas follow | 100 (`PRIORITY.catalog`) | latest only | 1 |
| `video` | H.264 baseline (Annex B) or VP8 frames, hang `legacy` container (varint µs timestamp + payload) | 1 group = 1 GoP, starting with a keyframe (keyframe every 2 s) | 60 (`PRIORITY.video`) | subscriber max-age 500 ms | 1 |
| `audio` | Opus 48 kHz mono, 20 ms frames, 32 kbps | ~1 s per group | 80 (`PRIORITY.audio`) | subscriber max-age 300 ms | 1 |
| `presence` | JSON `{name, mic, cam}` via `@moq/json` Snapshot (`screen` added in phase 4) | snapshot opens a group, deltas follow; late joiners read the latest | 90 (`PRIORITY.text`) | latest only | 2 |
| `chat` | JSON `{id, ts, text}` per frame | hang JSON `mode: "stream"`, one group per session | low | ascending | 3 |

The screen broadcast (phase 4) carries `catalog.json` and `video` with a higher resolution and lower frame rate (e.g. 1080p at 5–15 fps) and no audio.

> **Design choice to validate in the spike:** presence could live as a custom section in `catalog.json` instead of a separate track. A separate track keeps the catalog purely about media. This doc assumes the separate track.

### 5.3 Media pipeline (low-level)

**Publish**
1. `getUserMedia({ video: 640x360@30, audio: { echoCancellation, noiseSuppression, autoGainControl } })`
2. `MediaStreamTrackProcessor` → `VideoFrame` / `AudioData`
3. `VideoEncoder` (`avc1.42E01F` baseline or `vp8`, ~800 kbps, `latencyMode: "realtime"`) and `AudioEncoder` (`opus`, ~32 kbps)
4. Wrap each chunk in the hang container and write it with `group.writeFrame({ payload, timestamp })`. Start a new video group on every keyframe.
5. Publish `catalog.json` from the encoder's `decoderConfig` (codec, description, codedWidth/Height, sampleRate, channels).

**Subscribe** (per remote participant)
1. Subscribe to `catalog.json` and configure `VideoDecoder` / `AudioDecoder`.
2. Subscribe to `video` and `audio` with the priorities above. Loop on `recvGroup()` and read frames.
3. Video: decode, then draw `VideoFrame` to a `<canvas>` (an OffscreenCanvas in a worker is optional).
4. Audio: decode, then pass to an `AudioWorklet` ring buffer with a small jitter buffer (40–80 ms) and play out.
5. Unsubscribe and close the decoders when the announcement is retracted.

Use the `@moq/hang` helpers for catalog encode/decode and container framing where they exist. Custom code is expected for capture, encoder lifecycle, and rendering, which is the learning goal.

## 6. Authentication

- **Keys:** `moq auth generate --algorithm ES256 --out infra/keys/private.jwk --public infra/keys/public.jwk`
- **Relay config:** `[auth] url = "http://127.0.0.1:4440/"`, with `moq auth serve --key infra/keys/public.jwk` running beside it.
- **Token minting (Bun):** `POST /api/rooms/:roomId/token { name }` returns `{ participantId, token, relayUrl }`. Claims:

```json
{
  "root": "rooms/<roomId>",
  "publish": ["<participantId>/**"],
  "subscribe": "**",
  "iat": 1760000000,
  "exp": 1760014400
}
```

- Each participant can publish only their own broadcasts and can subscribe to anything in the room. Other rooms are unreachable.
- Signing uses `@moq/auth` (preferred) or `jose` with the ES256 private JWK. **Do not add `aud` or other extra claims**, because the relay refuses unknown claims.
- `exp` is enforced for the whole session, so set a 4 h TTL for the POC. No refresh logic is needed.
- Rooms are unguessable IDs with no password. Anyone with the link can join.

## 7. Bun specifics

- Bun ≥ 1.3, with workspaces in the root `package.json` (`apps/*`, `packages/*`).
- `Bun.serve({ routes: { "/": indexHtml, "/room/:id": indexHtml, "/api/...": handler } })` uses HTML imports, so Bun bundles the React app with HMR in dev. No Vite is needed.
- `bun build` produces the production bundle, and `bun test` runs unit tests for path helpers, token claims, and container framing.
- Dev orchestration: `bun run dev` starts the Bun server, `moq-relay`, and `moq auth serve` in one command (a small Bun script or `concurrently`).
- The relay binary comes from `brew install moq-relay` / `cargo install moq-relay`, or Docker. The `moq` CLI is needed for `moq auth`.

## 8. Environment and browser support

| Browser | Transport | POC support |
|---|---|---|
| Chrome / Edge ≥ 97 | WebTransport | **Primary target** |
| Firefox ≥ 153 | WebTransport | Best effort |
| Safari / iOS browsers | WebSocket fallback (TCP head-of-line blocking) | Out of scope for phase 1, revisit later |

- **Local TLS:** the relay uses `tls.generate = ["localhost"]` and serves its certificate fingerprint over `[web.http]`. The client fetches the fingerprint and pins it via WebTransport `serverCertificateHashes`. The hostname must match the certificate.
- **LAN demo:** to test across machines, run with a LAN hostname or IP in `tls.generate`. A real certificate, such as one from mkcert or Let's Encrypt on a dev domain, is optional.
- `getUserMedia` needs a secure context, so the Bun server must run on `localhost` or HTTPS.

## 9. Phased delivery plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Spike** (infra) | Monorepo scaffold. Relay, auth server, and keys running. Bun mints a token. Browser connects and publishes/subscribes a "hello" text track. Confirm actual `@moq/net` / `@moq/hang` APIs and versions. | Two tabs exchange text frames through the relay using a JWT. A cross-room subscribe is refused. |
| **1 — Audio + Video** | Create/join room, capture, encode, publish catalog/video/audio, roster via announcements, subscribe and render grid, leave. | 3–4 participants in Chrome on one LAN see and hear each other. Latency under 500 ms on LAN. Tiles appear and disappear on join and leave. |
| **2 — Roster and controls** | Presence track, display names, mic mute (stop sending audio groups), camera off (stop video, show avatar), active-speaker highlight (optional, from audio levels). | State changes reflect for all peers within 1 s. Late joiners see the correct state. |
| **3 — Chat** | Chat track per participant. Client merges messages by timestamp. Side panel UI. | Messages delivered to all current participants. Late joiners see the history of currently present participants (from the group cache). |
| **4 — Screen share** | `getDisplayMedia`, second broadcast `<pid>/screen`, spotlight layout. | Shared screen is readable at 1080p, and the camera keeps working at the same time. |
| **5 — Hardening (optional)** | Network throttling tests, simple stats overlay (bitrate, dropped groups, latency), adaptive bitrate or a second rendition, Firefox check. | Documented behavior under 1 Mbps / 5% loss. |

## 10. Non-functional targets

| Metric | Target (LAN, Chrome) |
|---|---|
| Glass-to-glass latency | < 300 ms typical, < 500 ms p95 |
| Join-to-first-frame | < 1.5 s (bounded by keyframe interval) |
| Participants | 8 (8 × ~850 kbps down ≈ 7 Mbps per client) |
| CPU | 8 decodes at 360p on a recent laptop without dropping below 25 fps |
| Under congestion | Audio continues, and video drops or freezes rather than building latency |

## 11. Proposed repository layout

```
moq-meeting/
├── apps/
│   ├── server/          # Bun.serve: routes, /api, JWT signing
│   └── web/             # React app: index.html, src/{media,moq,ui}
├── packages/
│   └── shared/          # paths, track names, message schemas
├── infra/
│   ├── relay/relay.toml
│   └── keys/            # git-ignored JWKs
├── scripts/dev.ts       # starts relay + auth + server
├── docs/INTAKE.md
└── package.json         # Bun workspaces
```

## 12. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| MoQ libraries are under active development and APIs may change | Breakage, outdated docs | Pin exact versions. Phase 0 spike confirms APIs. Keep a thin adapter (`apps/web/src/moq/`) around `@moq/net`. |
| **Echo:** browser AEC may not cancel audio played through WebAudio/AudioWorklet | Echo or feedback in phase 1 | Spike it early. Fallbacks: route playback through an `<audio>` element via `MediaStreamTrackGenerator`, or use headphones for the POC. |
| Low-level pipeline is substantial (A/V sync, jitter buffer, encoder errors) | Schedule | Keep to 360p/30 single rendition. No lip-sync beyond shared timestamps for the POC. Read `@moq/publish` / `@moq/watch` source as a reference implementation. |
| Self-signed cert and fingerprint quirks | Can't connect | Use the documented `[web.http]` fingerprint flow and stick to `localhost` in early phases. |
| Codec support varies per browser | Black video | Probe with `VideoEncoder.isConfigSupported` and prefer H.264 baseline, falling back to VP8. |
| Decode load with 8 participants | CPU spikes | Hardware decode via WebCodecs. Phase 5 can add a lower rendition for thumbnails. |

## 13. Assumptions

1. "Low-level" means we orchestrate capture, encode, framing, and decode ourselves on top of `@moq/net`, but we still use `@moq/hang` utilities (catalog types, container framing) instead of reimplementing them.
2. A single relay on a developer machine or a single VM is enough. No clustering.
3. Display names are not unique and not verified.
4. Room lifetime is implicit: a room exists while anyone is announcing in it. The Bun server stores rooms only in memory, so a server restart only affects new token issuance.
5. No UI library requirement. Plain CSS or Tailwind is fine.

## 14. Resolved questions

All defaults were accepted on 2026-10-09, with Q1 extended: a cloud deployment guide is now in scope.

| # | Question | Decision |
|---|---|---|
| Q1 | Internet demo or LAN only? | Localhost/LAN for development. Cloud VM + real domain documented in [DEPLOYMENT.md](DEPLOYMENT.md). |
| Q2 | Room access control? | None beyond an unguessable link |
| Q3 | Video codec? | H.264 baseline, VP8 fallback |
| Q4 | Firefox / Safari? | Chrome/Edge only. Firefox best-effort in phase 5. |
| Q5 | Persist chat for late joiners? | No, live-only |
| Q6 | UI styling? | Tailwind (introduced in phase 1; the phase 0 spike uses plain CSS) |
| Q7 | Corporate networks blocking UDP? | Assume UDP. The WebSocket fallback is automatic and documented. |
| Q8 | CI? | GitHub Actions: lint + typecheck + `bun test` + build ([ci.yml](../.github/workflows/ci.yml)) |

## 15. Phase 0 outcome

Exit criteria met:
- `bun run smoke` passes 5/5 over WebSocket: discovery, frame delivery, leave/retract, a cross-room token refused, and impersonated publishing refused.
- Two Chrome tabs exchange frames over **WebTransport** with the pinned dev certificate (`moq-lite-06`).

Learnings that changed the design are recorded in [notes/moq-api.md](notes/moq-api.md). The main one is that the publish claim is just `<participantId>/**`.

## 16. Phase 1 outcome

Built on `@moq/net` + `@moq/hang` building blocks (`Container.Legacy.Producer`, `Container.Consumer`, `Catalog.watch`, `@moq/json` Snapshot), with our own capture, WebCodecs, render and playout code.

Measured with 3 participants in Chrome tabs on one machine, using the synthetic test source:

| Exit criterion | Result |
|---|---|
| 3–4 participants see and hear each other | 3 participants, full mesh: 30 fps, H.264 360p, audio flowing (level meter) to every peer |
| Latency under 500 ms on LAN | Under about one frame (~15–35 ms) on localhost. The meter carries a one-frame offset error (see notes); there is no relay hop latency to speak of locally. |
| Tiles appear and disappear on join and leave | Leave removed the tile in under 20 ms. A late joiner drew the first frame from 2 peers **79 ms** after clicking Join (relay serves the current GoP from cache). |
| Join-to-first-frame < 1.5 s | 79 ms locally |

**Not yet verified:**
- **Real camera/mic and echo cancellation with speakers.** This needs a person in the room. Playout follows `@moq/watch` (AudioWorklet → destination) and relies on Chrome's tab-wide AEC. If echo shows up, the fallback is routing playout through a `MediaStreamTrackGenerator` → `<audio>` element.
- Behavior under congestion (phase 5), and cross-machine LAN latency.

## 17. Phase 2 outcome

| Exit criterion | Result |
|---|---|
| State changes reach all peers within 1 s | Mute + camera-off seen by another tab **5 ms** after the click (browser). Headless smoke: **2 ms**. |
| Late joiners see the correct state | A late joiner saw a muted, camera-off peer **46 ms** after Join (browser). Also covered by smoke. |
| Display names | From presence. A tile reads "Joining…" until presence arrives. |
| Mic mute | Track disabled, encoder flushed, group `cut()`. Unmute opens a new group. |
| Camera off / on | Track disabled (camera light off) with an avatar shown. Resume forces a keyframe, and the first new frame was drawn **35 ms** after the click. |
| Active speaker (optional) | Speaking ring per tile, from decoded audio RMS for peers and an AnalyserNode for yourself (≈ −42 dBFS threshold, 400 ms hold) |

`bun run smoke` now has 8 checks, including presence delivery and late-join state.

## 18. Next steps

1. Manual check, still open: two machines on one LAN with real cameras and speakers. Confirm no echo, record latency, and check that the speaking threshold suits real voices.
2. Phase 3: chat via `@moq/json` Stream, one track per participant, merged by timestamp.
3. Switch to the reconnecting `Moq.Connection` handle.
