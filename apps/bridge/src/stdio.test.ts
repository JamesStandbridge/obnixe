import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, expect, it } from "vitest";

const main = fileURLToPath(new URL("./main.ts", import.meta.url));
const nodeArgs = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", main];
let configDir: string;
let configFile: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "obnixe-stdio-"));
  configFile = join(configDir, "obnixe", "bridge.json");
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

it("runs under node type stripping, serves MCP over stdio and creates a private bridge file", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: nodeArgs,
    env: { ...process.env, OBNIXE_PHONE_HOST: "127.0.0.1", OBNIXE_PHONE_PORT: "0", OBNIXE_CONTROL_PORT: "0", OBNIXE_BRIDGE_CONFIG: configFile } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "codex-mcp-client", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  expect(tools).toHaveLength(24);
  const result = await client.callTool({ name: "list_programs", arguments: {} });
  expect(result.isError).toBe(true);
  await client.close();
  expect(statSync(configFile).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({ bridgeId: expect.any(String), pairings: [], revoked: [] });
}, 20_000);

it("forgets without a running bridge", () => {
  const result = spawnSync(process.execPath, [...nodeArgs, "forget"], {
    env: { ...process.env, OBNIXE_CONTROL_PORT: "1", OBNIXE_BRIDGE_CONFIG: configFile },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("No phone is paired with this Mac.\n");
}, 20_000);
