import { chmod, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const outfile = fileURLToPath(new URL("../dist/main.mjs", import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
  outfile,
  bundle: true,
  minify: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "import { createRequire as obnixeCreateRequire } from 'node:module'; const require = obnixeCreateRequire(import.meta.url);" },
});

const bundled = await readFile(outfile, "utf8");
const body = bundled.startsWith("#!") ? bundled.slice(bundled.indexOf("\n") + 1) : bundled;
await writeFile(outfile, `#!/usr/bin/env node\n${body}`);
await chmod(outfile, 0o755);
