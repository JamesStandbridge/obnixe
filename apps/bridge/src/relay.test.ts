import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  PhoneSession,
  closeConnection,
  encodeRelayMessage,
  generateIdentity,
  openConnection,
  pairingRelayRoom,
  parseRelayToPhone,
  relayPeerLeftMessage,
  relayProtocolVersion,
  relaySocketUrl,
  renameConnectionClient,
  runAgentTool,
} from "@obnixe/core";
import type { PhoneLinkStatus, PhonePairing } from "@obnixe/core";
import { createTestContext } from "@obnixe/core/testing";
import type { TestContext } from "@obnixe/core/testing";
import { settings } from "@obnixe/schema";
import { PairingFile } from "./pairings.ts";
import { PhoneEndpoint } from "./phone.ts";

const bytes = (length: number): Uint8Array => new Uint8Array(randomBytes(length));
const livePorts = new Set([7429, 7430, 8081]);
const relayMain = join(dirname(createRequire(import.meta.url).resolve("obnixe-relay/package.json")), "src", "main.ts");
const bridgeArgs = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./main.ts", import.meta.url))];
const deviceId = generateIdentity(bytes);

type PhoneTarget = { readonly kind: "direct"; readonly url: string } | { readonly kind: "relay"; readonly relayUrl: string; readonly room: string };

interface TestPhone {
  readonly session: PhoneSession;
  readonly socket: WebSocket;
  readonly statuses: PhoneLinkStatus[];
  readonly paired: PhonePairing[];
  readonly relayNotices: string[];
  readonly state: { peered: boolean; closed: boolean };
}

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
}

let context: TestContext;
let configDir: string;
let configFile: string;
let relayPort: number;
let relayUrl: string;
let relay: ChildProcess | null = null;
let endpoint: PhoneEndpoint | null = null;
const logs: string[] = [];
const phones: WebSocket[] = [];

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const { port: bound } = server.address() as AddressInfo;
        server.close(() => resolve(bound));
      });
    });
    if (!livePorts.has(port)) return port;
  }
}

async function startRelay(): Promise<void> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", relayMain], {
    env: { ...process.env, PORT: String(relayPort), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("Listening on port")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`The relay exited with ${String(code)}`)));
  });
  relay = child;
}

async function stopRelay(): Promise<void> {
  const child = relay;
  relay = null;
  if (child === null || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

function connectPhone(target: PhoneTarget, code: string, pairing: PhonePairing | null = null): TestPhone {
  const socket = new WebSocket(target.kind === "direct" ? target.url : relaySocketUrl(target.relayUrl));
  phones.push(socket);
  const statuses: PhoneLinkStatus[] = [];
  const paired: PhonePairing[] = [];
  const relayNotices: string[] = [];
  const state = { peered: target.kind === "direct", closed: false };
  const session = new PhoneSession({
    code,
    device: "iPhone",
    deviceId,
    pairing,
    revocation: null,
    randomBytes: bytes,
    now: Date.now,
    socket: { send: (text) => socket.send(text), close: () => socket.close() },
    handlers: {
      onStatus: (status) => statuses.push(status),
      onOpen: (peer) => openConnection(context.db, context.env, peer),
      onClient: (connectionId, name) => renameConnectionClient(context.db, connectionId, name),
      onCall: (connectionId, tool, args) => runAgentTool(context.db, context.env, { connectionId, tool, arguments: args, timeZone: "Europe/Paris" }),
      onRejected: () => undefined,
      onPaired: (stored) => paired.push(stored),
      onRevocationSent: () => undefined,
    },
  });
  if (target.kind === "relay") socket.on("open", () => socket.send(encodeRelayMessage({ type: "join", v: relayProtocolVersion, role: "phone", room: target.room })));
  socket.on("message", (data) => {
    const text = String(data);
    if (!state.peered) {
      const notice = parseRelayToPhone(text);
      relayNotices.push(notice.type);
      state.peered = notice.type === "peer";
      return;
    }
    if (text === relayPeerLeftMessage) {
      relayNotices.push("peer_left");
      socket.close();
      return;
    }
    void session.receive(text);
  });
  socket.on("close", () => {
    state.closed = true;
    const connectionId = session.connectionId;
    if (connectionId !== null && !session.isClosed) closeConnection(context.db, context.env, connectionId, "network");
    session.markClosed();
  });
  return { session, socket, statuses, paired, relayNotices, state };
}

function storedPairing(phone: TestPhone): PhonePairing {
  const [pairing] = phone.paired;
  if (pairing === undefined) throw new Error("The phone stored no pairing");
  return pairing;
}

function startEndpoint(pairings: PairingFile): PhoneEndpoint {
  const started = new PhoneEndpoint({ port: 0, hostLabel: "MacBook Pro", pairings, randomBytes: bytes, log: (line) => logs.push(line), callTimeoutMs: 5000 });
  started.connectRelay(relayUrl);
  endpoint = started;
  return started;
}

async function pairThroughInvite(bridge: PhoneEndpoint): Promise<TestPhone> {
  const invite = bridge.openInviteRoom();
  if (invite === null) throw new Error("No relay configured");
  expect(invite.relayUrl).toBe(relayUrl);
  const phone = connectPhone({ kind: "relay", relayUrl: invite.relayUrl, room: invite.room }, "482917");
  await until(() => bridge.status().phone === "waiting", "hello through the relay");
  expect(await bridge.pair("482917")).toEqual({ kind: "paired", device: "iPhone", client: "Agent" });
  await until(() => phone.statuses.includes("open"), "open session");
  bridge.closeInviteRoom();
  return phone;
}

async function startBridgeProcess(env: Readonly<Record<string, string>>): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: bridgeArgs, env: { ...(process.env as Record<string, string>), ...env }, stderr: "pipe" });
  transport.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  const client = new Client({ name: "cursor-vscode", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function runCli(args: readonly string[], env: Readonly<Record<string, string>>): Promise<CliResult> {
  const child = spawn(process.execPath, [...bridgeArgs, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  return new Promise<CliResult>((resolve) => child.once("exit", (status) => resolve({ status, stdout })));
}

async function controlStatus(controlPort: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${controlPort}/status`);
  return ((await response.json()) as { phone: string }).phone;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = (result as CallToolResult).content;
  return first?.type === "text" ? first.text : "";
}

beforeEach(async () => {
  context = createTestContext();
  context.db
    .insert(settings)
    .values({
      singleton: 1,
      theme: "dark",
      massUnit: "kg",
      agentCanReadBody: false,
      agentCanWrite: false,
      agentCanReadPhotos: false,
      reminderWeekdays: 0,
      reminderMinutes: 1110,
      remindersExportedAt: null,
      agentChangesSeenAt: null,
      bridgeHost: null,
      updatedAt: context.env.now(),
    })
    .run();
  logs.length = 0;
  configDir = mkdtempSync(join(tmpdir(), "obnixe-relay-"));
  configFile = join(configDir, "obnixe", "bridge.json");
  relayPort = await freePort();
  relayUrl = `ws://127.0.0.1:${relayPort}`;
  await startRelay();
});

afterEach(async () => {
  for (const socket of phones.splice(0)) socket.terminate();
  await endpoint?.close();
  endpoint = null;
  await stopRelay();
  rmSync(configDir, { recursive: true, force: true });
});

describe("bridge behind the relay", () => {
  it("pairs a new phone through an invite room, then resumes it through the room of its pairing", async () => {
    const pairings = new PairingFile(configFile, bytes);
    const bridge = startEndpoint(pairings);
    const first = await pairThroughInvite(bridge);
    const pairing = storedPairing(first);
    const [stored] = pairings.list();
    if (stored === undefined) throw new Error("The bridge stored no pairing");
    expect(pairingRelayRoom(stored)).toBe(pairingRelayRoom(pairing));
    expect((await bridge.callTool("list_sports", {})).isError).toBe(false);

    first.session.close("user");
    await until(() => bridge.status().phone === "none", "bridge drop");
    await until(() => first.state.closed, "invite phone closed");

    const resumed = connectPhone({ kind: "relay", relayUrl, room: pairingRelayRoom(pairing) }, "000000", pairing);
    await until(() => resumed.statuses.includes("open"), "resumed session");
    expect(resumed.statuses).toEqual(["resuming", "open"]);
    expect(resumed.paired).toEqual([]);
    expect((await bridge.callTool("list_programs", {})).isError).toBe(false);

    bridge.forgetAll();
    await until(() => resumed.state.closed, "forgotten session closed");
    const forgotten = connectPhone({ kind: "relay", relayUrl, room: pairingRelayRoom(pairing) }, "000000", pairing);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(forgotten.state.peered).toBe(false);
  }, 30_000);

  it("closes the invite room after pairing and rejoins every room when the relay comes back", async () => {
    const bridge = startEndpoint(new PairingFile(configFile, bytes));
    const invite = bridge.openInviteRoom();
    if (invite === null) throw new Error("No relay configured");
    bridge.closeInviteRoom();
    const first = await pairThroughInvite(bridge);
    const pairing = storedPairing(first);
    const stale = connectPhone({ kind: "relay", relayUrl, room: invite.room }, "000000");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stale.state.peered).toBe(false);

    await stopRelay();
    await until(() => first.state.closed, "phone dropped with the relay");
    await until(() => bridge.status().phone === "none", "bridge drop");
    await startRelay();
    await until(() => logs.filter((line) => line.startsWith("Reachable through the relay")).length === 2, "bridge back on the relay");
    const resumed = connectPhone({ kind: "relay", relayUrl, room: pairingRelayRoom(pairing) }, "000000", pairing);
    await until(() => resumed.statuses.includes("open"), "resumed after relay restart");
  }, 30_000);

  it("serves MCP tool calls to a phone resumed through the relay while the direct listener is off", async () => {
    const phonePort = await freePort();
    const controlPort = await freePort();
    const env = { OBNIXE_BRIDGE_CONFIG: configFile, OBNIXE_CONTROL_PORT: String(controlPort), OBNIXE_RELAY_URL: relayUrl };

    const pairingBridge = await startBridgeProcess({ ...env, OBNIXE_PHONE_HOST: "127.0.0.1", OBNIXE_PHONE_PORT: String(phonePort) });
    const direct = connectPhone({ kind: "direct", url: `ws://127.0.0.1:${phonePort}` }, "482917");
    await until(async () => (await controlStatus(controlPort)) === "waiting", "hello on the direct listener");
    const pair = await runCli(["pair", "482917"], env);
    expect(pair.status).toBe(0);
    expect(pair.stdout).toContain("Connected to iPhone");
    await until(() => direct.statuses.includes("open"), "paired session");
    const pairing = storedPairing(direct);
    await pairingBridge.close();
    await until(() => direct.state.closed, "direct socket closed");

    const relayedBridge = await startBridgeProcess({ ...env, OBNIXE_PHONE_PORT: "off" });
    const refused = new WebSocket(`ws://127.0.0.1:${phonePort}`);
    phones.push(refused);
    expect(await new Promise<string>((resolve) => refused.once("error", (error) => resolve(error.message)))).toContain("ECONNREFUSED");
    const relayed = connectPhone({ kind: "relay", relayUrl, room: pairingRelayRoom(pairing) }, "000000", pairing);
    await until(() => relayed.statuses.includes("open"), "resumed through the relay");
    expect(relayed.statuses).toEqual(["resuming", "open"]);
    const sports = await relayedBridge.callTool({ name: "list_sports", arguments: {} });
    expect(sports.isError).toBe(false);
    expect(JSON.parse(textOf(sports)).catalogVersion).toBe(1);
    await relayedBridge.close();
    await until(() => relayed.state.closed, "relayed phone closed with the bridge");
    expect(relayed.relayNotices).toEqual(["peer", "peer_left"]);
  }, 60_000);
});
