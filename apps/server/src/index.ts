import {
	type ApiError,
	type CreateRoomResponse,
	isValidId,
	MAX_NAME_LENGTH,
	randomId,
	roomPath,
	type TokenResponse,
} from "@moq-meeting/shared";
import index from "../../web/index.html";
import { loadConfig } from "./config";
import { loadSigningKey, participantClaims, signToken } from "./token";

const config = loadConfig();
const signingKey = await loadSigningKey(config.privateKeyFile);

/** Cached so every token request doesn't hit the relay; refreshed if the relay restarts. */
let fingerprint: { value: string; fetchedAt: number } | undefined;

async function relayFingerprint(): Promise<string | undefined> {
	if (!config.relayFingerprintUrl) return undefined;
	if (fingerprint && Date.now() - fingerprint.fetchedAt < 10_000) return fingerprint.value;
	const res = await fetch(config.relayFingerprintUrl);
	if (!res.ok) throw new Error(`relay fingerprint: HTTP ${res.status}`);
	fingerprint = { value: (await res.text()).trim(), fetchedAt: Date.now() };
	return fingerprint.value;
}

function error(status: number, message: string): Response {
	return Response.json({ error: message } satisfies ApiError, { status });
}

const server = Bun.serve({
	port: config.port,
	development: config.development && { hmr: true, console: true },
	routes: {
		"/": index,
		"/room/:roomId": index,

		"/api/health": () => Response.json({ ok: true }),

		"/api/rooms": {
			POST: () => Response.json({ roomId: randomId() } satisfies CreateRoomResponse),
		},

		"/api/rooms/:roomId/token": {
			POST: async (req) => {
				const { roomId } = req.params;
				if (!isValidId(roomId)) return error(400, "invalid room id");

				const body = (await req.json().catch(() => undefined)) as { name?: unknown } | undefined;
				const name = typeof body?.name === "string" ? body.name.trim().slice(0, MAX_NAME_LENGTH) : "";
				if (!name) return error(400, "name is required");

				const participantId = randomId();
				const now = Math.floor(Date.now() / 1000);
				const claims = participantClaims(roomId, participantId, now, config.tokenTtlSeconds);
				const token = await signToken(signingKey, claims);

				let certificateHash: string | undefined;
				try {
					certificateHash = await relayFingerprint();
				} catch (err) {
					console.error(err);
					return error(502, "relay unreachable");
				}

				const relayUrl = new URL(`${config.relayUrl}/${roomPath(roomId)}`);
				relayUrl.searchParams.set("jwt", token);

				return Response.json({
					roomId,
					participantId,
					name,
					relayUrl: relayUrl.toString(),
					expiresAt: claims.exp as number,
					certificateHash,
				} satisfies TokenResponse);
			},
		},

		"/api/*": () => error(404, "not found"),
	},
});

console.log(`moq-meeting server on ${server.url} (relay ${config.relayUrl})`);
