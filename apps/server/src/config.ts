/** Server configuration, read once from the environment. Defaults target local dev. */
export interface Config {
	port: number;
	/** Public relay base URL the browser dials (no room path, no query). */
	relayUrl: string;
	/**
	 * Where to fetch the relay's self-signed certificate fingerprint. Dev only: leave
	 * unset in production, where the relay has a real certificate.
	 */
	relayFingerprintUrl?: string;
	privateKeyFile: string;
	tokenTtlSeconds: number;
	development: boolean;
}

export function loadConfig(env = process.env): Config {
	const development = env.NODE_ENV !== "production";
	return {
		port: Number(env.PORT ?? 3000),
		relayUrl: stripTrailingSlash(env.RELAY_URL ?? "https://localhost:4443"),
		relayFingerprintUrl:
			env.RELAY_FINGERPRINT_URL ?? (development ? "http://localhost:4443/certificate.sha256" : undefined),
		privateKeyFile: env.MOQ_PRIVATE_KEY_FILE ?? "infra/keys/private.jwk",
		tokenTtlSeconds: Number(env.TOKEN_TTL_SECONDS ?? 4 * 60 * 60),
		development,
	};
}

function stripTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}
