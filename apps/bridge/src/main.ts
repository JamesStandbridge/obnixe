#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultControlPort, defaultPhonePort } from "@obnixe/core/agent/wire";
import { startControl } from "./control.ts";
import type { ControlServer } from "./control.ts";
import { createMcpServer, hostLabel } from "./mcp.ts";
import { runPair } from "./pair.ts";
import { PhoneEndpoint } from "./phone.ts";

function port(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error(`${name} must be a TCP port, got ${value}`);
  return parsed;
}

const phonePort = port("OBNIXE_PHONE_PORT", defaultPhonePort);
const controlPort = port("OBNIXE_CONTROL_PORT", defaultControlPort);

function log(line: string): void {
  process.stderr.write(`[obnixe] ${line}\n`);
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

async function serve(): Promise<void> {
  const endpoint = new PhoneEndpoint({ port: phonePort, hostLabel: hostLabel(), randomBytes: (length) => new Uint8Array(randomBytes(length)), log });
  let control: ControlServer | null = null;
  try {
    await endpoint.listen();
    control = await startControl(endpoint, controlPort);
    log(`En attente du téléphone sur le port ${phonePort}.`);
  } catch (error) {
    if (!isAddressInUse(error)) throw error;
    const message = `Another Obnixe bridge already uses port ${phonePort} or ${controlPort}. Only one MCP client can reach the phone at a time; close the other one or set OBNIXE_PHONE_PORT and OBNIXE_CONTROL_PORT.`;
    endpoint.markUnavailable(message);
    log(message);
  }
  const server = createMcpServer(endpoint);
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void Promise.all([endpoint.close(), control?.close()]).then(() => process.exit(0));
  };
  await server.connect(transport);
}

const usage = `obnixe-bridge, MCP server relaying an agent to the Obnixe phone app.

  obnixe-bridge          MCP server on stdio (started by Cursor or Codex)
  obnixe-bridge pair     Pair the phone with the code shown on its Agent screen

Cursor (~/.cursor/mcp.json):
  { "mcpServers": { "obnixe": { "command": "node", "args": ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "${fileURLToPath(import.meta.url)}"] } } }

The phone dials ws://<this Mac>:${phonePort} (OBNIXE_PHONE_PORT); pairing uses http://127.0.0.1:${controlPort} (OBNIXE_CONTROL_PORT).
`;

const [command, argument] = process.argv.slice(2);
switch (command) {
  case undefined:
    await serve();
    break;
  case "pair":
    process.exitCode = await runPair({ controlPort, code: argument, interactive: process.stdin.isTTY, input: process.stdin, output: process.stdout });
    break;
  case "help":
  case "--help":
  case "-h":
    process.stdout.write(usage);
    break;
  default:
    process.stderr.write(usage);
    process.exitCode = 2;
}
