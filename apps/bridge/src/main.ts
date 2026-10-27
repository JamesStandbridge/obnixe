#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultControlPort, defaultPhonePort, isRelayUrl } from "@obnixe/core/agent/wire";
import { startControl } from "./control.ts";
import type { ControlServer } from "./control.ts";
import { runForget } from "./forget.ts";
import { selectPhoneHosts } from "./listen.ts";
import type { PhoneHosts } from "./listen.ts";
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

function relayUrl(): string | null {
  const value = process.env.OBNIXE_RELAY_URL;
  if (value === undefined || value === "") return null;
  if (!isRelayUrl(value)) throw new Error(`OBNIXE_RELAY_URL must be a wss:// URL, got ${value}`);
  return value;
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

function describeListening(hosts: PhoneHosts, port: number): string {
  const listed = hosts.bind.map((address) => `${address}:${port}`).join(", ");
  switch (hosts.source) {
    case "override":
      return `Waiting for the phone on ${listed} (OBNIXE_PHONE_HOST).`;
    case "interfaces":
      return hosts.advertise.length === 0
        ? `No private network address found (Wi-Fi, Ethernet or Tailscale), so the bridge only listens on ${listed} and the phone cannot reach it. Join the phone's network and the bridge will pick the address up.`
        : `Waiting for the phone on ${listed}.`;
    default: {
      const unreachable: never = hosts.source;
      throw new Error(`Unhandled phone host source ${String(unreachable)}`);
    }
  }
}

/** Opens the QR page in the default browser when there is one; the terminal QR code stays the fallback. */
function openPage(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (opener === null) return;
  const child = spawn(opener, [url], { stdio: "ignore", detached: true });
  child.on("error", (error) => log(`Could not open a browser (${error.message}); use the QR code above.`));
  child.unref();
}

async function serve(): Promise<void> {
  const override = process.env.OBNIXE_PHONE_HOST;
  const phoneHosts = (): PhoneHosts => selectPhoneHosts(networkInterfaces(), override);
  const endpoint = new PhoneEndpoint({
    port: phonePort,
    hosts: phoneHosts,
    hostLabel: hostLabel(),
    relayUrl: relayUrl(),
    pairings,
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
    log,
    onError: (error) => log(`Address rescan failed: ${error instanceof Error ? error.message : String(error)}`),
  });
  let control: ControlServer | null = null;
  try {
    const listening = await endpoint.listen();
    control = await startControl(endpoint, controlPort);
    log(describeListening(phoneHosts(), listening));
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

  obnixe-bridge              MCP server on stdio (started by Cursor or Codex)
  obnixe-bridge pair         Show a QR code to scan from the Agent screen of the phone
  obnixe-bridge pair <code>  Pair with the 6-digit code shown on the phone, when its camera is unavailable
  obnixe-bridge forget       Forget the paired phone; it will need to pair again

Cursor: open ${cursorInstallLink}
  or add to ~/.cursor/mcp.json: { "mcpServers": { "obnixe": ${JSON.stringify(serverConfig)} } }
Codex: codex mcp add obnixe -- npx -y obnixe-bridge

The phone dials ws://<address of this Mac>:${phonePort}. The listener binds 127.0.0.1, every private LAN IPv4 address
(10/8, 172.16/12, 192.168/16) and every Tailscale address (100.64.0.0/10), never a public one, and follows address
changes; the QR code and every session tell the phone these addresses, LAN first. OBNIXE_PHONE_HOST binds a single
address instead and OBNIXE_PHONE_PORT changes the port. Traffic is authenticated and encrypted end to end.
The QR page and pairing use http://127.0.0.1:${controlPort} (OBNIXE_CONTROL_PORT); http://127.0.0.1:${controlPort}/pair shows the QR code.
OBNIXE_RELAY_URL (wss://) adds a relay rendezvous to the QR code.
A paired phone reconnects without a code using the secret kept in ${pairings.path} (OBNIXE_BRIDGE_CONFIG).
`;

const [command, argument] = process.argv.slice(2);
switch (command) {
  case undefined:
    await serve();
    break;
  case "pair":
    process.exitCode = await runPair({
      controlPort,
      code: argument,
      interactive: process.stdin.isTTY,
      input: process.stdin,
      output: process.stdout,
      openPage: process.stdout.isTTY ? openPage : null,
    });
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
