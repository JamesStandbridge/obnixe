import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await build({
  entryPoints: [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/main.mjs", import.meta.url)),
  bundle: true,
  minify: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "import { createRequire as obnixeCreateRequire } from 'node:module'; const require = obnixeCreateRequire(import.meta.url);" },
});
