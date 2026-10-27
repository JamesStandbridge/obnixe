import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const executable = process.argv[2];
if (executable === undefined) throw new Error("Usage: node scripts/smoke.mjs <obnixe-bridge executable>");
const binary = resolve(executable);
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

const home = mkdtempSync(join(tmpdir(), "obnixe-smoke-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), OBNIXE_BRIDGE_CONFIG: join(home, "bridge.json"), OBNIXE_RELAY_URL: "" };
try {
  const printed = execFileSync(binary, ["--version"], { env, encoding: "utf8" }).trim();
  if (printed !== version) throw new Error(`--version printed ${printed}, expected ${version}`);
  process.stdout.write(`--version: ${printed}\n`);

  const dryRun = execFileSync(binary, ["install", "--client", "cursor", "--dry-run"], { env, encoding: "utf8" });
  const fold = (text) => (process.platform === "win32" ? text.toLowerCase() : text);
  if (!fold(dryRun).includes(fold(`"command":${JSON.stringify(binary)}`))) throw new Error(`install --dry-run does not point at ${binary}:\n${dryRun}`);
  process.stdout.write(`install --dry-run:\n${dryRun}`);

  const phonePort = await freePort();
  const controlPort = await freePort();
  const bridge = spawn(binary, [], { env: { ...env, OBNIXE_PHONE_PORT: String(phonePort), OBNIXE_CONTROL_PORT: String(controlPort) }, stdio: ["pipe", "ignore", "inherit"] });
  try {
    let status = null;
    for (let attempt = 0; attempt < 50 && status === null; attempt += 1) {
      await sleep(200);
      try {
        const response = await fetch(`http://127.0.0.1:${controlPort}/status`);
        if (response.ok) status = await response.json();
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
    if (status === null) throw new Error(`The bridge never answered on http://127.0.0.1:${controlPort}/status`);
    process.stdout.write(`/status: ${JSON.stringify(status)}\n`);
  } finally {
    bridge.kill();
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
