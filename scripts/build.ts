/** Production bundle: server + client in dist/. Run it from dist/ (see `bun run start`). */
import tailwind from "bun-plugin-tailwind";

const result = await Bun.build({
	entrypoints: ["apps/server/src/index.ts"],
	target: "bun",
	outdir: "dist",
	root: ".",
	publicPath: "/",
	minify: true,
	sourcemap: "linked",
	plugins: [tailwind],
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
for (const out of result.outputs)
	console.log(`${out.path.replace(`${process.cwd()}/`, "")}  ${(out.size / 1024).toFixed(1)} KB`);
