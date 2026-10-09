/**
 * Local dev: start `moq auth serve`, `moq-relay`, and the Bun app server (with HMR)
 * together, and stop them all on Ctrl-C. Generates signing keys on first run.
 */
import { existsSync } from "node:fs";
import { $, type Subprocess } from "bun";

const KEYS = { private: "infra/keys/private.jwk", public: "infra/keys/public.jwk" };

for (const bin of ["moq", "moq-relay"]) {
	if (!Bun.which(bin)) {
		console.error(
			`missing \`${bin}\` on PATH; install with: brew install moq-relay moq (or cargo install moq-relay moq-cli)`,
		);
		process.exit(1);
	}
}

if (!existsSync(KEYS.private)) {
	console.log("generating ES256 signing keys in infra/keys/");
	await $`moq auth generate --algorithm ES256 --out ${KEYS.private} --public ${KEYS.public}`;
}

const procs: Subprocess[] = [];
function start(name: string, cmd: string[], env: Record<string, string> = {}) {
	const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
	procs.push(proc);
	proc.exited.then((code) => {
		console.error(`[${name}] exited with ${code}`);
		shutdown(code ?? 1);
	});
}

let stopping = false;
function shutdown(code = 0) {
	if (stopping) return;
	stopping = true;
	for (const p of procs) p.kill();
	process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("auth", ["moq", "auth", "serve", "--key", KEYS.public]);
start("relay", ["moq-relay", "infra/relay/relay.dev.toml"], { RUST_LOG: process.env.RUST_LOG ?? "info" });

// Wait for the relay's HTTP listener so the first token request can fetch its fingerprint.
for (let i = 0; i < 50; i++) {
	if (
		await fetch("http://localhost:4443/certificate.sha256").then(
			(r) => r.ok,
			() => false,
		)
	)
		break;
	await Bun.sleep(100);
}

start("server", ["bun", "--hot", "apps/server/src/index.ts"]);
