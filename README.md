# MoQ Meeting

A small browser-based meeting app on [Media over QUIC](https://doc.moq.dev/), as a proof of concept. It runs a Bun app server, the official `moq-relay`, and a React client built directly on `@moq/net` / `@moq/hang`.

- [Intake document](docs/INTAKE.md): scope, architecture, phases
- [Cloud deployment](docs/DEPLOYMENT.md): single VM, real domain, Let's Encrypt
- [MoQ API notes](docs/notes/moq-api.md): what the spike learned about the libraries

**Status:** Phases 0–5 done. Multi-party audio + video over WebTransport (WebSocket fallback), display names, mute / camera-off, speaking indicators, room chat with history for late joiners, 1080p screen share with a spotlight layout, auto-reconnect, and congestion handling (audio-only fallback, adaptive jitter buffer, adaptive bitrate). Works in Chrome, Firefox 157 and Safari 27. See [INTAKE §20](docs/INTAKE.md) for measured results.

Use `?source=test` (or pick "Test pattern & tone" when joining) to try it without a camera, e.g. several tabs on one machine.

## Prerequisites

- [Bun](https://bun.com/) 1.4+
- `moq-relay` 0.17+ and the `moq` CLI 0.14+: `brew install moq-dev/tap/moq-relay moq-dev/tap/moq` (or see the [install docs](https://doc.moq.dev/setup/))
- Chrome or Edge for WebTransport. Other browsers use the WebSocket fallback.

## Run locally

```bash
bun install
bun run dev        # auth server + relay (:4443) + app (:3000); generates dev keys on first run
```

Open http://localhost:3000, create a room, then open the room link in a second tab.

## Scripts

| Command | What it does |
|---|---|
| `bun run dev` | Full local stack with HMR |
| `bun run smoke [baseUrl]` | Headless end-to-end check (pub/sub, discovery, presence, chat, screen share, leave, auth scoping) |
| `bun scripts/netem.ts --down 300 --loss 2 --delay 40` | UDP impairment proxy on :4444 for congestion tests (`--help` in the file header) |
| `bun test` | Unit tests |
| `bun run lint` / `typecheck` | Biome / tsc |
| `bun run build` / `start` | Production bundle in `dist/` / run it |

## Layout

```
apps/server     Bun.serve: web app, /api/rooms, /api/rooms/:id/token (JWT)
apps/web        React client; src/moq/ wraps @moq/net
packages/shared Path conventions, track names, API types
infra/relay     relay.dev.toml, relay.prod.toml
infra/deploy    Caddyfile, systemd units
scripts         dev.ts (orchestrator), smoke.ts
```

## Dev URL parameters

Room URLs (`/room/<id>?…`) accept these testing aids:

| Param | Effect |
|---|---|
| `source=test` | Synthetic camera (pattern + beep) and screen (1080p slide) instead of real devices |
| `heavy=1` | Noisy test pattern that drives the encoder to its bitrate ceiling |
| `relayPort=4444` | Route this tab through `scripts/netem.ts` |
| `mstp=0` | Force the capture fallback used by browsers without `MediaStreamTrackProcessor` |
| `autojoin=1&name=X` | Join on load (for browsers you can't click in) |
| `report=1` | Post this tab's view (browser, transport, per-peer stats, recent warnings) to chat every 10 s |
| `debug=1` | Expose the session as `window.moq` (e.g. `await moq.netStats()`) |
