#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { isSea } from "node:sea";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultControlPort, defaultPhonePort, defaultRelayUrl, isRelayUrl } from "@obnixe/core/agent/wire";
import { startControl } from "./control.ts";
import type { ControlServer } from "./control.ts";
import { runForget } from "./forget.ts";
import { applyToClients, commandLine, launchCommand, parseClientCommand, systemClaudeCli } from "./install.ts";
import type { ConfigAction, LaunchCommand } from "./install.ts";
import { selectPhoneHosts } from "./listen.ts";
import type { PhoneHosts } from "./listen.ts";
import { bridgeVersion, createMcpServer, hostLabel } from "./mcp.ts";
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
  const value = process.env.OBNIXE_RELAY_URL ?? defaultRelayUrl;
  if (value === "") return null;
  if (!isRelayUrl(value)) throw new Error(`OBNIXE_RELAY_URL must be a ws:// or wss:// URL, got ${value}`);
  return value;
}

const phonePort = process.env.OBNIXE_PHONE_PORT === "off" ? null : port("OBNIXE_PHONE_PORT", defaultPhonePort);
const controlPort = port("OBNIXE_CONTROL_PORT", defaultControlPort);
const relay = relayUrl();
const pairings = new PairingFile(pairingFilePath(process.env, process.platform, homedir()), (length) => new Uint8Array(randomBytes(length)));
const launch: LaunchCommand = launchCommand(isSea(), process.execPath, process.execArgv, process.argv[1] === undefined ? undefined : resolve(process.argv[1]));

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

function browserCommand(url: string): LaunchCommand | null {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "linux":
      return { command: "xdg-open", args: [url] };
    case "win32":
      // `start` takes its first quoted argument as the window title; Node quotes the empty argument as "".
      return { command: "cmd", args: ["/c", "start", "", url] };
    default:
      return null;
  }
}

/** Opens the QR page in the default browser when there is one; the terminal QR code stays the fallback. */
function openPage(url: string): void {
  const opener = browserCommand(url);
  if (opener === null) return;
  const child = spawn(opener.command, [...opener.args], { stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", (error) => log(`Could not open a browser (${error.message}); use the QR code above.`));
  child.unref();
}

async function serve(): Promise<void> {
  const override = process.env.OBNIXE_PHONE_HOST;
  const phoneHosts = (): PhoneHosts => selectPhoneHosts(networkInterfaces(), override);
  const endpoint = new PhoneEndpoint({
    port: phonePort ?? 0,
    hosts: phoneHosts,
    hostLabel: hostLabel(),
    pairings,
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
    log,
    onError: (error) => log(`Address rescan failed: ${error instanceof Error ? error.message : String(error)}`),
  });
  let control: ControlServer | null = null;
  try {
    const listening = phonePort === null ? null : await endpoint.listen();
    control = await startControl(endpoint, controlPort);
    log(listening === null ? "The direct phone listener is off (OBNIXE_PHONE_PORT=off)." : describeListening(phoneHosts(), listening));
    if (relay !== null) endpoint.connectRelay(relay);
  } catch (error) {
    if (!isAddressInUse(error)) throw error;
    const ports = phonePort === null ? `port ${controlPort}` : `port ${phonePort} or ${controlPort}`;
    const message = `Another Obnixe bridge already uses ${ports}. Only one MCP client can reach the phone at a time; close the other one or set OBNIXE_PHONE_PORT and OBNIXE_CONTROL_PORT.`;
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

const serverConfig = { command: launch.command, args: launch.args };
const launchLine = commandLine([launch.command, ...launch.args]);

const usage = `obnixe-bridge ${bridgeVersion}, MCP server that lets an AI agent (Cursor, Claude, any MCP client) read and log training data in the Obnixe phone app.

  obnixe-bridge              MCP server on stdio, started by the MCP client
  obnixe-bridge install [--client cursor|claude-desktop|claude-code|all] [--dry-run]
                             Add the obnixe server to the MCP config of each client found (all by default)
  obnixe-bridge uninstall [--client cursor|claude-desktop|claude-code|all] [--dry-run]
                             Remove the obnixe server from those configs
  obnixe-bridge pair         Show a QR code to scan from the Agent screen of the phone
  obnixe-bridge pair <code>  Pair with the 6-digit code shown on the phone, when its camera is unavailable
  obnixe-bridge forget       Forget the paired phone; it will need to pair again
  obnixe-bridge --version    Print the version

Other MCP clients: register a stdio server named obnixe running ${launchLine}
  for example { "mcpServers": { "obnixe": ${JSON.stringify(serverConfig)} } }, or for Codex: codex mcp add obnixe -- ${launchLine}

The phone dials ws://<address of this computer>:${phonePort ?? defaultPhonePort}. The listener binds 127.0.0.1, every private LAN IPv4 address
(10/8, 172.16/12, 192.168/16) and every Tailscale address (100.64.0.0/10), never a public one, and follows address
changes; the QR code and every session tell the phone these addresses, LAN first. OBNIXE_PHONE_HOST binds a single
address instead and OBNIXE_PHONE_PORT changes the port (off disables the listener). Traffic is authenticated and
encrypted end to end.
The QR page and pairing use http://127.0.0.1:${controlPort} (OBNIXE_CONTROL_PORT); http://127.0.0.1:${controlPort}/pair shows the QR code.
Away from that network the phone reaches the bridge through the relay set by OBNIXE_RELAY_URL (wss://...), which only
forwards end-to-end sealed frames${relay === null ? "; no relay is configured" : `; currently ${relay}`}. The QR code then
also carries a one-time relay room, so a phone can pair through the relay with the QR code, never with a typed code.
A paired phone reconnects without a code using the secret kept in ${pairings.path} (OBNIXE_BRIDGE_CONFIG).
`;

function runClientConfig(action: ConfigAction, args: readonly string[]): number {
  const parsed = parseClientCommand(args);
  switch (parsed.kind) {
    case "invalid":
      process.stderr.write(`${parsed.message} See obnixe-bridge --help.\n`);
      return 2;
    case "ok":
      break;
    default: {
      const unreachable: never = parsed;
      throw new Error(`Unhandled client command ${JSON.stringify(unreachable)}`);
    }
  }
  const { selection, dryRun } = parsed.command;
  const report = applyToClients(action, selection, {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    launch,
    claude: systemClaudeCli(process.env, process.platform),
    dryRun,
  });
  const lines: string[] = action === "install" ? [`Command: ${launchLine}`, ...report.lines] : [...report.lines];
  if (report.ok && !dryRun) lines.push(action === "install" ? "Restart the MCP client, then run `obnixe-bridge pair` if the phone is not paired yet." : "Restart the MCP client to stop the bridge.");
  (report.ok ? process.stdout : process.stderr).write(`${lines.join("\n")}\n`);
  return report.ok ? 0 : 1;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case undefined:
      await serve();
      break;
    case "pair":
      process.exitCode = await runPair({
        controlPort,
        code: rest[0],
        interactive: process.stdin.isTTY,
        input: process.stdin,
        output: process.stdout,
        openPage: process.stdout.isTTY ? openPage : null,
      });
      break;
    case "forget":
      process.exitCode = await runForget({ controlPort, pairings, output: process.stdout });
      break;
    case "install":
    case "uninstall":
      process.exitCode = runClientConfig(command, rest);
      break;
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${bridgeVersion}\n`);
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
}

void main();
