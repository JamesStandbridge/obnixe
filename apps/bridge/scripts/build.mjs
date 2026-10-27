import { chmod, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const outfile = fileURLToPath(new URL("../dist/main.mjs", import.meta.url));

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  minify: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "import { createRequire as obnixeCreateRequire } from 'node:module'; const require = obnixeCreateRequire(import.meta.url);" },
});

async function withoutShebang(file) {
  const bundled = await readFile(file, "utf8");
  return bundled.startsWith("#!") ? bundled.slice(bundled.indexOf("\n") + 1) : bundled;
}

await writeFile(outfile, `#!/usr/bin/env node\n${await withoutShebang(outfile)}`);
await chmod(outfile, 0o755);

// A single executable application runs one CommonJS script whose require only reaches Node builtins.
const seaEntry = fileURLToPath(new URL("../dist/sea/main.cjs", import.meta.url));
await build({
  entryPoints: [entry],
  outfile: seaEntry,
  bundle: true,
  minify: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  logOverride: { "empty-import-meta": "error" },
});
await writeFile(seaEntry, await withoutShebang(seaEntry));
await chmod(seaEntry, 0o644);
