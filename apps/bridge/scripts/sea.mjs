import { execFileSync } from "node:child_process";
import { chmod, copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postject from "postject";

const targets = { "darwin-arm64": "darwin-arm64", "darwin-x64": "darwin-x64", "linux-arm64": "linux-arm64", "linux-x64": "linux-x64", "win32-x64": "win-x64" };
const target = targets[`${process.platform}-${process.arch}`];
if (target === undefined) throw new Error(`No obnixe-bridge executable for ${process.platform}-${process.arch}`);

const dist = (name) => fileURLToPath(new URL(`../dist/${name}`, import.meta.url));
const config = dist("sea/sea-config.json");
const blob = dist("sea/sea-prep.blob");
const executable = dist(`obnixe-bridge-${target}${process.platform === "win32" ? ".exe" : ""}`);

await writeFile(config, `${JSON.stringify({ main: dist("sea/main.cjs"), output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2)}\n`);
execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });

await copyFile(process.execPath, executable);
await chmod(executable, 0o755);
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", executable], { stdio: "inherit" });
await postject.inject(executable, "NODE_SEA_BLOB", await readFile(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", executable], { stdio: "inherit" });

const { size } = await stat(executable);
process.stdout.write(`${executable} (${(size / 1024 / 1024).toFixed(1)} MB, Node ${process.versions.node})\n`);
