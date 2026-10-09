# Deploying MoQ Meeting to a cloud server with a real domain

This guide puts the whole stack on **one Linux VM** with two hostnames and publicly trusted TLS certificates. Browsers then connect over WebTransport with no certificate pinning, and Safari and UDP-blocked networks fall back to WebSocket.

Config files referenced here live in [`infra/`](../infra). Replace `example.com` everywhere with your domain.

## 1. Topology

```
                         ┌──────────────────────── VM (Ubuntu 24.04) ───────────────────────┐
 browser ── TCP 443 ──►  │ Caddy (TLS, h1/h2 only)                                          │
                         │   meet.example.com  ─► 127.0.0.1:3000  Bun app (moq-meeting)     │
                         │   relay.example.com ─► 127.0.0.1:4080  moq-relay WS fallback     │
 browser ── UDP 443 ──►  │ moq-relay  QUIC/WebTransport, cert for relay.example.com         │
                         │   └─ auth ─► 127.0.0.1:4440  moq auth serve (public.jwk)         │
                         └──────────────────────────────────────────────────────────────────┘
```

| Hostname | Port | Served by | Purpose |
|---|---|---|---|
| `meet.example.com` | TCP 443 | Caddy → Bun `:3000` | Web UI, `/api/rooms`, `/api/rooms/:id/token` |
| `relay.example.com` | **UDP 443** | `moq-relay` directly | QUIC / WebTransport media |
| `relay.example.com` | TCP 443 | Caddy → relay `:4080` | WebSocket fallback, plus the ACME certificate |

Why it's laid out this way:
- QUIC needs UDP, so the relay binds UDP 443 itself. Caddy is limited to HTTP/1.1 and HTTP/2 so it doesn't take UDP 443 for HTTP/3.
- Caddy obtains and renews the `relay.example.com` certificate. A systemd path unit copies it to `/etc/moq/tls/`, and the relay watches those files and reloads them for new connections.
- `moq auth serve`, the relay's WebSocket port, and the Bun server bind only to loopback.

## 2. Prerequisites

- **VM:** 2 vCPU / 4 GB RAM is plenty for ≤ 8 participants per room and a few rooms. The relay forwards traffic without transcoding, so bandwidth is the real limit. One 8-person room uses about 7 Mbps down per participant, roughly 55 Mbps of relay egress in total.
- **OS:** Ubuntu 22.04+ or Debian 12+ (the moq apt repo supports these).
- **Static public IP.** IPv6 is optional but recommended, since the relay binds `[::]`.
- **DNS:** `A` (and `AAAA`) records for `meet.example.com` and `relay.example.com` pointing at the VM.
- **Cloud firewall / security group** inbound:

| Protocol | Port | Why |
|---|---|---|
| TCP | 22 | SSH (restrict to your IP) |
| TCP | 80 | ACME HTTP-01 challenge and HTTP→HTTPS redirect |
| TCP | 443 | HTTPS app + WebSocket fallback |
| **UDP** | **443** | QUIC / WebTransport |

> Corporate networks often block outbound UDP 443. Clients on those networks connect through the WebSocket fallback automatically, with higher latency under loss.

## 3. Install

```bash
sudo apt update && sudo apt install -y curl unzip debian-keyring debian-archive-keyring apt-transport-https
```

**MoQ relay + CLI** (official apt repo, per the moq install docs):

```bash
curl -fsSL https://apt.moq.dev/moq-keyring.gpg | sudo tee /usr/share/keyrings/moq-keyring.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/moq-keyring.gpg] https://apt.moq.dev stable main" | sudo tee /etc/apt/sources.list.d/moq.list
sudo apt update && sudo apt install -y moq-relay moq
moq-relay --version   # expect 0.17.x, matching local dev
```

**Caddy** (official apt repo):

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

**Bun** (system-wide at `/usr/local/bin/bun`):

```bash
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash
bun --version   # 1.4.x
```

**Kernel UDP buffers.** The relay asks for 8 MiB buffers and logs a warning if the kernel clamps them:

```bash
printf 'net.core.rmem_max = 8388608\nnet.core.wmem_max = 8388608\n' | sudo tee /etc/sysctl.d/60-moq.conf
sudo sysctl --system
```

**Service user and directories:**

```bash
sudo useradd --system --home /opt/moq-meeting --shell /usr/sbin/nologin moq
sudo mkdir -p /etc/moq/keys /etc/moq/tls /opt/moq-meeting
sudo chown -R moq:moq /etc/moq /opt/moq-meeting
sudo chmod 700 /etc/moq/keys
```

## 4. Signing keys

Generate the keys **on the server**. Never reuse the dev keys from `infra/keys/`.

```bash
sudo -u moq moq auth generate --algorithm ES256 \
  --out /etc/moq/keys/private.jwk --public /etc/moq/keys/public.jwk
sudo chmod 600 /etc/moq/keys/private.jwk
```

- `private.jwk` is read only by the Bun app (`moq-meeting.service`), which signs tokens.
- `public.jwk` is read only by `moq-auth.service`, which verifies tokens for the relay.

## 5. Deploy the app

From your machine (or CI), build and copy the bundle:

```bash
bun install --frozen-lockfile
bun run build
rsync -az --delete dist/ user@vm:/tmp/moq-meeting-dist/
```

On the VM:

```bash
sudo rsync -a --delete /tmp/moq-meeting-dist/ /opt/moq-meeting/dist/
sudo chown -R moq:moq /opt/moq-meeting
```

The bundle is self-contained (server + client assets), so no `bun install` is needed on the VM. It must run with `dist/` as the working directory, because Bun resolves the bundled HTML assets relative to the working directory. The systemd unit sets this.

## 6. Configure

Copy the configs from the repo, replacing `example.com` with your domain:

```bash
DOMAIN=example.com
sudo sed "s/example.com/$DOMAIN/g" infra/relay/relay.prod.toml | sudo tee /etc/moq/relay.toml
sudo sed "s/example.com/$DOMAIN/g" infra/deploy/Caddyfile | sudo tee /etc/caddy/Caddyfile
for f in infra/deploy/systemd/*; do
  sudo sed "s/example.com/$DOMAIN/g" "$f" | sudo tee /etc/systemd/system/$(basename "$f") > /dev/null
done
sudo systemctl daemon-reload
```

Files and what they do:

| File | Installed at | Notes |
|---|---|---|
| [`relay.prod.toml`](../infra/relay/relay.prod.toml) | `/etc/moq/relay.toml` | UDP 443 QUIC with real cert, WS on `127.0.0.1:4080`, auth via `127.0.0.1:4440` |
| [`Caddyfile`](../infra/deploy/Caddyfile) | `/etc/caddy/Caddyfile` | Set `email`. HTTP/3 disabled so UDP 443 stays free |
| [`moq-auth.service`](../infra/deploy/systemd/moq-auth.service) | `/etc/systemd/system/` | `moq auth serve --key public.jwk` |
| [`moq-relay.service`](../infra/deploy/systemd/moq-relay.service) | `/etc/systemd/system/` | `CAP_NET_BIND_SERVICE` to bind 443 as the `moq` user |
| [`moq-meeting.service`](../infra/deploy/systemd/moq-meeting.service) | `/etc/systemd/system/` | `NODE_ENV=production`, `RELAY_URL=https://relay.<domain>` |
| [`moq-relay-cert.path`/`.service`](../infra/deploy/systemd/) | `/etc/systemd/system/` | Copies Caddy's renewed cert to `/etc/moq/tls/` |

In production `RELAY_FINGERPRINT_URL` is **unset**. Tokens then carry no certificate hash and the browser verifies the relay's real certificate normally.

## 7. Start (order matters once)

```bash
# 1. Caddy first: it obtains certificates for both hostnames.
sudo systemctl enable --now caddy
sudo journalctl -u caddy -f        # wait for "certificate obtained successfully" x2

# 2. Copy the relay certificate, and keep watching for renewals.
sudo systemctl start moq-relay-cert.service
sudo systemctl enable --now moq-relay-cert.path
ls -l /etc/moq/tls/                # relay.crt, relay.key owned by moq

# 3. Auth, relay, app.
sudo systemctl enable --now moq-auth moq-relay moq-meeting
```

## 8. Verify

```bash
# App and API through Caddy
curl -fsS https://meet.example.com/api/health                      # {"ok":true}
curl -fsS -X POST https://meet.example.com/api/rooms                # {"roomId":"…"}

# Relay certificate is publicly trusted, and the WS fallback is reachable via Caddy
curl -fsS -o /dev/null -w '%{http_code}\n' https://relay.example.com/certificate.sha256

# UDP 443 is listening (on the VM)
sudo ss -ulpn | grep ':443'                                         # moq-relay

# End-to-end headless check from your laptop (uses the WebSocket path)
bun run smoke https://meet.example.com
```

**Browser check:** open `https://meet.example.com` in two Chrome windows, create a room, and join from both. The status badge should read `connected (webtransport)`. If it reads `websocket`, UDP 443 isn't reaching the relay (check the cloud firewall and `ss -ulpn`).

## 9. Operations

| Task | How |
|---|---|
| Logs | `journalctl -u moq-relay -u moq-auth -u moq-meeting -f` |
| Deploy new version | rebuild, rsync `dist/`, then `sudo systemctl restart moq-meeting`. The relay and auth stay up. |
| Certificate renewal | Automatic: Caddy renews, the path unit copies, the relay reloads |
| Rotate signing keys | Generate a new pair, then restart `moq-auth` and `moq-meeting`. Existing sessions keep running until their `exp`. |
| Upgrade relay | `sudo apt update && sudo apt install moq-relay moq`, then `sudo systemctl restart moq-relay`. Clients reconnect. |
| Lock down SSH | Security group to your IP, `PasswordAuthentication no` |

## 10. Security notes

- Tokens travel in the relay URL's `?jwt=` query. Caddy writes no access logs unless you add a `log` directive. If you add one, filter the query string out.
- Tokens are bearer credentials scoped to one room, publish limited to `<participantId>/**`, and a 4 h TTL. Anyone with a room link can mint one; there is no room access control yet (intake Q2).
- `moq auth serve` has no authentication of its own, so keep it on loopback (the default `127.0.0.1:4440`). Don't pass `--listen-public`.
- Keep `/etc/moq/keys` at `700` and `private.jwk` at `600`, owned by `moq`.

## 11. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Badge shows `websocket` instead of `webtransport` | UDP 443 blocked (security group, host firewall, or client network), or Caddy is still advertising HTTP/3 |
| `relay unreachable` / connection timeout | `moq-relay` not running, or `/etc/moq/tls/relay.*` missing (run `moq-relay-cert.service`) |
| `unauthorized` / `forbidden` in relay logs | `moq-auth` down, key mismatch between `private.jwk` and `public.jwk`, or the token's `root` doesn't match the room path |
| Relay warns about clamped UDP buffers | Apply the sysctl in §3 |
| Blank page / 404 for `/index-*.js` | `moq-meeting` not running with `WorkingDirectory=/opt/moq-meeting/dist` |

## 12. Alternatives

- **Separate relay host:** put `moq-relay` on its own VM, or several in a cluster later. The Bun app only needs `RELAY_URL` changed. Use this to scale media independently of the app.
- **Docker:** `moqdev/moq-relay` and `moqdev/moq` images exist (linux/amd64 and arm64). Publish UDP and TCP for the relay port and mount `relay.toml` and the TLS files read-only.
- **certbot instead of Caddy for the relay cert:** works too. Point `[listen.tls]` at `/etc/letsencrypt/live/relay.example.com/fullchain.pem` / `privkey.pem` and make them readable by `moq`.
