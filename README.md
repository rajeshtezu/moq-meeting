# MoQ Meeting

A small browser-based meeting app on [Media over QUIC](https://doc.moq.dev/), as a proof of concept. It runs a Bun app server, the official `moq-relay`, and a React client built directly on `@moq/net` / `@moq/hang`.

- [Intake document](docs/INTAKE.md): scope, architecture, phases
- [Cloud deployment](docs/DEPLOYMENT.md): single VM, real domain, Let's Encrypt
- [MoQ API notes](docs/notes/moq-api.md): what the spike learned about the libraries

**Status:** Phase 0 (spike) done. Join a room with a JWT, discover peers, exchange text frames over WebTransport.

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
| `bun run smoke [baseUrl]` | Headless end-to-end check (pub/sub, discovery, leave, auth scoping) |
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
