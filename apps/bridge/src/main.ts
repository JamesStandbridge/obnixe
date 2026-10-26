#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultControlPort, defaultPhonePort } from "@obnixe/core/agent/wire";
import { startControl } from "./control.ts";
import type { ControlServer } from "./control.ts";
import { runForget } from "./forget.ts";
import { selectPhoneHost } from "./listen.ts";
import type { PhoneHost } from "./listen.ts";
import { createMcpServer, hostLabel } from "./mcp.ts";
import { runPair } from "./pair.ts";
import { PairingFile, pairingFilePath } from "./pairings.ts";
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
const pairings = new PairingFile(pairingFilePath(process.env), (length) => new Uint8Array(randomBytes(length)));

function log(line: string): void {
  process.stderr.write(`[obnixe] ${line}\n`);
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

function describeListening(host: PhoneHost): string {
  switch (host.source) {
    case "override":
      return `Waiting for the phone on ${host.address}:${phonePort} (OBNIXE_PHONE_HOST).`;
    case "tailscale":
      return `Waiting for the phone on the Tailscale address ${host.address}:${phonePort}.`;
    case "loopback":
      return `No Tailscale address (100.64.0.0/10) found on this machine, so the bridge only listens on ${host.address}:${phonePort} and the phone cannot reach it. Start Tailscale and restart the bridge, or set OBNIXE_PHONE_HOST to the address the phone should dial.`;
    default: {
      const unreachable: never = host.source;
      throw new Error(`Unhandled phone host source ${String(unreachable)}`);
    }
  }
}

async function serve(): Promise<void> {
  const host = selectPhoneHost(networkInterfaces(), process.env.OBNIXE_PHONE_HOST);
  const endpoint = new PhoneEndpoint({ port: phonePort, listenHost: host.address, hostLabel: hostLabel(), pairings, randomBytes: (length) => new Uint8Array(randomBytes(length)), log });
  let control: ControlServer | null = null;
  try {
    await endpoint.listen();
    control = await startControl(endpoint, controlPort);
    log(describeListening(host));
  } catch (error) {
    if (!isAddressInUse(error)) throw error;
    const message = `Another Obnixe bridge already uses port ${phonePort} or ${controlPort}. Only one MCP client can reach the phone at a time; close the other one or set OBNIXE_PHONE_PORT and OBNIXE_CONTROL_PORT.`;
    endpoint.markUnavailable(message);
    log(message);
  }
  const server = createMcpServer(endpoint);
  const transport = new StdioServerTransport();
  const shutdown = (): void => {
    void Promise.all([endpoint.close(), control?.close()]).then(() => process.exit(0));
  };
  transport.onclose = shutdown;
  await server.connect(transport);
  // The stdio transport does not report the client closing stdin, which would leave the bridge holding its ports.
  process.stdin.once("end", shutdown);
}

const serverConfig = { command: "npx", args: ["-y", "obnixe-bridge"] };
const cursorInstallLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=obnixe&config=${Buffer.from(JSON.stringify(serverConfig)).toString("base64")}`;

const usage = `obnixe-bridge, MCP server relaying an agent to the Obnixe phone app.

  obnixe-bridge          MCP server on stdio (started by Cursor or Codex)
  obnixe-bridge pair     Pair the phone with the code shown on its Agent screen
  obnixe-bridge forget   Forget the paired phone; it will need a new code

Cursor: open ${cursorInstallLink}
  or add to ~/.cursor/mcp.json: { "mcpServers": { "obnixe": ${JSON.stringify(serverConfig)} } }
Codex: codex mcp add obnixe -- npx -y obnixe-bridge

The phone dials ws://<Tailscale address of this Mac>:${phonePort}. The listener binds the first Tailscale IPv4 address
(100.64.0.0/10), or 127.0.0.1 when there is none; OBNIXE_PHONE_HOST overrides the address and OBNIXE_PHONE_PORT the port.
Pairing uses http://127.0.0.1:${controlPort} (OBNIXE_CONTROL_PORT).
A paired phone reconnects without a code using the secret kept in ${pairings.path} (OBNIXE_BRIDGE_CONFIG).
`;

const [command, argument] = process.argv.slice(2);
switch (command) {
  case undefined:
    await serve();
    break;
  case "pair":
    process.exitCode = await runPair({ controlPort, code: argument, interactive: process.stdin.isTTY, input: process.stdin, output: process.stdout });
    break;
  case "forget":
    process.exitCode = await runForget({ controlPort, pairings, output: process.stdout });
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
