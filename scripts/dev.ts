/**
 * Local dev: start `moq auth serve`, `moq-relay`, and the Bun app server (with HMR)
 * together, and stop them all on Ctrl-C. Generates signing keys and a dev TLS cert on
 * first run. If the relay exits it is restarted (so you can kill it to test reconnects);
 * if anything else exits, everything stops.
 */
import { existsSync } from "node:fs";
import { $, type Subprocess } from "bun";

const KEYS = { private: "infra/keys/private.jwk", public: "infra/keys/public.jwk" };
const TLS = { dir: "infra/relay/dev-tls", cert: "infra/relay/dev-tls/cert.pem", key: "infra/relay/dev-tls/key.pem" };

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

// Regenerate the dev cert when missing or within a day of expiry (`-checkend` exits non-zero).
const certValid =
	existsSync(TLS.cert) &&
	(await $`openssl x509 -checkend 86400 -noout -in ${TLS.cert}`.nothrow().quiet()).exitCode === 0;
if (!certValid) {
	console.log("generating a 10-day dev TLS certificate in infra/relay/dev-tls/");
	await $`mkdir -p ${TLS.dir}`;
	await $`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ${TLS.key} -out ${TLS.cert} -days 10 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1`.quiet();
}

const procs = new Set<Subprocess>();
function start(name: string, cmd: string[], env: Record<string, string> = {}, restart = false) {
	const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
	procs.add(proc);
	proc.exited.then((code) => {
		procs.delete(proc);
		if (stopping) return;
		console.error(`[${name}] exited with ${code}`);
		if (restart) {
			console.error(`[${name}] restarting in 1 s`);
			setTimeout(() => !stopping && start(name, cmd, env, restart), 1000);
		} else shutdown(code ?? 1);
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
start("relay", ["moq-relay", "infra/relay/relay.dev.toml"], { RUST_LOG: process.env.RUST_LOG ?? "info" }, true);

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
