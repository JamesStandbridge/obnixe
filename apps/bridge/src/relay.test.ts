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
  parseInvite,
  parseRelayToPhone,
  relayPeerLeftMessage,
  relayProtocolVersion,
  relaySocketUrl,
  renameConnectionClient,
  runAgentTool,
  toBase64,
} from "@obnixe/core";
import type { PhoneLinkStatus, PhonePairing, PhoneSecret } from "@obnixe/core";
import { createTestContext } from "@obnixe/core/testing";
import type { TestContext } from "@obnixe/core/testing";
import { settings } from "@obnixe/schema";
import { PairingFile } from "./pairings.ts";
import type { BridgePairing } from "./pairings.ts";
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
  readonly rejections: string[];
  readonly relayNotices: string[];
  readonly state: { peered: boolean; closed: boolean };
}

interface RawPhone {
  readonly received: string[];
  readonly state: { closed: boolean };
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

function connectPhone(target: PhoneTarget, code: string | PhoneSecret, pairing: PhonePairing | null = null): TestPhone {
  const socket = new WebSocket(target.kind === "direct" ? target.url : relaySocketUrl(target.relayUrl));
  phones.push(socket);
  const statuses: PhoneLinkStatus[] = [];
  const paired: PhonePairing[] = [];
  const rejections: string[] = [];
  const relayNotices: string[] = [];
  const state = { peered: target.kind === "direct", closed: false };
  const session = new PhoneSession({
    secret: typeof code === "string" ? { kind: "code", code } : code,
    device: "iPhone",
    deviceId,
    pairing,
    pairOtherBridges: false,
    revocation: null,
    randomBytes: bytes,
    now: Date.now,
    socket: { send: (text) => socket.send(text), close: () => socket.close() },
    handlers: {
      onStatus: (status) => statuses.push(status),
      onOpen: (peer) => openConnection(context.db, context.env, peer),
      onClient: (connectionId, name) => renameConnectionClient(context.db, connectionId, name),
      onCall: (connectionId, tool, args) => runAgentTool(context.db, context.env, { connectionId, tool, arguments: args, timeZone: "Europe/Paris" }),
      onRejected: (reason) => rejections.push(reason),
      onPaired: (learned) => paired.push({ ...learned, lastHost: null, relay: target.kind === "relay" ? { url: target.relayUrl, room: target.room } : null }),
      onHosts: () => undefined,
      onRevocationAcknowledged: () => undefined,
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
  return { session, socket, statuses, paired, rejections, relayNotices, state };
}

function storedPairing(phone: TestPhone): PhonePairing {
  const [pairing] = phone.paired;
  if (pairing === undefined) throw new Error("The phone stored no pairing");
  return pairing;
}

interface StartedEndpoint {
  readonly bridge: PhoneEndpoint;
  readonly directUrl: string;
}

function newEndpoint(pairings: PairingFile): PhoneEndpoint {
  const bridge = new PhoneEndpoint({
    port: 0,
    hosts: () => ({ bind: ["127.0.0.1"], advertise: ["127.0.0.1"], source: "override" }),
    hostLabel: "MacBook Pro",
    pairings,
    randomBytes: bytes,
    log: (line) => logs.push(line),
    onError: (error) => logs.push(`error: ${String(error)}`),
    callTimeoutMs: 5000,
  });
  endpoint = bridge;
  return bridge;
}

async function startEndpoint(pairings: PairingFile): Promise<StartedEndpoint> {
  const bridge = newEndpoint(pairings);
  const port = await bridge.listen();
  bridge.connectRelay(relayUrl);
  return { bridge, directUrl: `ws://127.0.0.1:${port}` };
}

async function pairDirectly(started: StartedEndpoint): Promise<TestPhone> {
  const phone = connectPhone({ kind: "direct", url: started.directUrl }, "482917");
  await until(() => started.bridge.status().phone === "waiting", "hello on the direct listener");
  expect(await started.bridge.pair("482917")).toEqual({ kind: "paired", device: "iPhone", client: "Agent" });
  await until(() => phone.statuses.includes("open"), "open session");
  return phone;
}

function fakePairing(index: number): BridgePairing {
  return { pairingId: toBase64(bytes(16)), deviceId: toBase64(bytes(16)), device: `Phone ${index}`, secret: toBase64(bytes(32)), pairedAt: Date.now() };
}

function rawRelayPhone(room: string): RawPhone {
  const socket = new WebSocket(relaySocketUrl(relayUrl));
  phones.push(socket);
  const received: string[] = [];
  const state = { closed: false };
  socket.on("open", () => socket.send(encodeRelayMessage({ type: "join", v: relayProtocolVersion, role: "phone", room })));
  socket.on("message", (data) => received.push(String(data)));
  socket.on("close", () => {
    state.closed = true;
  });
  return { received, state };
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
  it("refuses code pairing through the relay, then resumes a directly paired phone through the room of its pairing", async () => {
    const pairings = new PairingFile(configFile, bytes);
    const started = await startEndpoint(pairings);
    const { bridge } = started;
    const invite = bridge.openInviteRoom();
    if (invite === null) throw new Error("No relay configured");
    expect(invite.relayUrl).toBe(relayUrl);
    const intruder = connectPhone({ kind: "relay", relayUrl, room: invite.room }, "482917");
    await until(() => intruder.state.closed, "relayed hello refused");
    expect(intruder.statuses).toContain("waiting");
    expect(bridge.status().phone).toBe("none");
    expect(logs.some((line) => line.startsWith("Refused to pair iPhone through the relay"))).toBe(true);
    bridge.closeInviteRoom();

    const first = await pairDirectly(started);
    const pairing = storedPairing(first);
    const [stored] = pairings.list();
    if (stored === undefined) throw new Error("The bridge stored no pairing");
    expect(pairingRelayRoom(stored)).toBe(pairingRelayRoom(pairing));
    first.session.close("user");
    await until(() => bridge.status().phone === "none", "bridge drop");

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

  it("pairs with the QR token through the invite room only, then resumes through the pairing room with no direct listener", async () => {
    const pairings = new PairingFile(configFile, bytes);
    const bridge = newEndpoint(pairings);
    bridge.connectRelay(relayUrl);
    const created = bridge.invite(true);
    if (created.kind !== "ready") throw new Error("Expected a relay-only invite");
    const invite = parseInvite(created.ticket.url, Date.now());
    expect(invite.hosts).toEqual([]);
    if (invite.relay === null) throw new Error("The invite carries no relay");
    expect(invite.relay.url).toBe(relayUrl);
    await until(() => logs.some((line) => line.startsWith("Reachable through the relay")), "bridge on the relay");
    const token: PhoneSecret = { kind: "token", token: invite.token, bridgeId: invite.bridgeId };
    const inviteRoom = { kind: "relay", relayUrl, room: invite.relay.room } as const;

    const coder = connectPhone(inviteRoom, "482917");
    await until(() => coder.state.closed, "code hello refused in the invite room");
    expect(coder.paired).toEqual([]);

    const phone = connectPhone(inviteRoom, token);
    await until(() => phone.statuses.includes("open"), "token pairing through the relay");
    const pairing = storedPairing(phone);
    await until(() => bridge.inviteStatus()?.state.kind === "paired", "bridge records the pairing");
    expect(bridge.inviteStatus()?.state).toMatchObject({ kind: "paired", device: "iPhone" });
    const late = connectPhone(inviteRoom, token);
    await until(() => late.state.closed, "spent token refused");
    expect(late.statuses).not.toContain("open");
    expect(late.paired).toEqual([]);

    phone.session.close("user");
    await until(() => bridge.status().phone === "none", "bridge drop");
    const next = bridge.invite(true);
    if (next.kind !== "ready") throw new Error("Expected a second invite");
    const second = parseInvite(next.ticket.url, Date.now());
    const wrongRoom = connectPhone({ kind: "relay", relayUrl, room: pairingRelayRoom(pairing) }, { kind: "token", token: second.token, bridgeId: second.bridgeId });
    await until(() => wrongRoom.state.closed, "token hello refused outside the invite room");
    expect(wrongRoom.statuses).not.toContain("open");

    const resumed = connectPhone({ kind: "relay", relayUrl, room: pairingRelayRoom(pairing) }, "000000", pairing);
    await until(() => resumed.statuses.includes("open"), "resume through the pairing room");
    expect(resumed.statuses).toEqual(["resuming", "open"]);
    await until(() => bridge.status().phone === "connected", "bridge session open");
    expect((await bridge.callTool("list_programs", {})).isError).toBe(false);
  }, 30_000);

  it("closes the invite room when the QR code expires", async () => {
    let now = Date.now();
    const bridge = new PhoneEndpoint({
      port: 0,
      hosts: () => ({ bind: ["127.0.0.1"], advertise: [], source: "interfaces" }),
      hostLabel: "MacBook Pro",
      pairings: new PairingFile(configFile, bytes),
      randomBytes: bytes,
      log: (line) => logs.push(line),
      onError: (error) => logs.push(`error: ${String(error)}`),
      now: () => now,
    });
    endpoint = bridge;
    bridge.connectRelay(relayUrl);
    const created = bridge.invite(true);
    if (created.kind !== "ready") throw new Error("Expected a relay-only invite");
    const invite = parseInvite(created.ticket.url, Date.now());
    if (invite.relay === null) throw new Error("The invite carries no relay");
    await until(() => logs.some((line) => line.startsWith("Reachable through the relay")), "bridge on the relay");
    now += 6 * 60_000;
    expect(bridge.inviteStatus()?.state).toEqual({ kind: "expired" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stale = connectPhone({ kind: "relay", relayUrl, room: invite.relay.room }, { kind: "token", token: invite.token, bridgeId: invite.bridgeId });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stale.state.peered).toBe(false);
  }, 30_000);

  it("leaves a closed invite room and rejoins every room when the relay comes back", async () => {
    const started = await startEndpoint(new PairingFile(configFile, bytes));
    const { bridge } = started;
    const invite = bridge.openInviteRoom();
    if (invite === null) throw new Error("No relay configured");
    bridge.closeInviteRoom();
    const pairing = storedPairing(await pairDirectly(started));
    await until(() => logs.some((line) => line.startsWith("Reachable through the relay")), "bridge on the relay");
    const stale = connectPhone({ kind: "relay", relayUrl, room: invite.room }, "000000");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stale.state.peered).toBe(false);

    const relayed = connectPhone({ kind: "relay", relayUrl, room: pairingRelayRoom(pairing) }, "000000", pairing);
    await until(() => relayed.statuses.includes("open"), "resumed through the relay");
    await stopRelay();
    await until(() => relayed.state.closed, "phone dropped with the relay");
    await until(() => bridge.status().phone === "none", "bridge drop");
    await startRelay();
    await until(() => logs.filter((line) => line.startsWith("Reachable through the relay")).length === 2, "bridge back on the relay");
    const resumed = connectPhone({ kind: "relay", relayUrl, room: pairingRelayRoom(pairing) }, "000000", pairing);
    await until(() => resumed.statuses.includes("open"), "resumed after relay restart");
  }, 30_000);

  it("keeps pending slots for direct phones when relayed peers pile up", async () => {
    const pairings = new PairingFile(configFile, bytes);
    const rooms = Array.from({ length: 5 }, (_, index) => {
      const pairing = fakePairing(index);
      pairings.remember(pairing);
      return pairingRelayRoom(pairing);
    });
    const started = await startEndpoint(pairings);
    const relayed = rooms.map((room) => rawRelayPhone(room));
    await until(() => relayed.filter((phone) => phone.received.some((text) => text.includes('"challenge"'))).length === 4 && relayed.some((phone) => phone.state.closed), "relayed slots full");
    expect(relayed.filter((phone) => phone.state.closed)).toHaveLength(1);
    expect(logs.some((line) => line.startsWith("Refused a connection from relay:"))).toBe(true);
    const direct = Array.from({ length: 2 }, () => connectPhone({ kind: "direct", url: started.directUrl }, "482917"));
    await until(() => direct.every((phone) => phone.statuses.includes("waiting")), "direct phones admitted");
    await until(() => logs.filter((line) => line.endsWith("is waiting to pair. Run `obnixe-bridge pair <code>` with the code shown on the phone.")).length === 2, "direct hellos held");
    expect(direct.every((phone) => !phone.state.closed)).toBe(true);
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
    await until(async () => (await controlStatus(controlPort)) === "connected", "bridge session open");
    const sports = await relayedBridge.callTool({ name: "list_sports", arguments: {} });
    expect(sports.isError).toBe(false);
    expect(JSON.parse(textOf(sports)).catalogVersion).toBe(1);
    await relayedBridge.close();
    await until(() => relayed.state.closed, "relayed phone closed with the bridge");
    expect(relayed.relayNotices).toEqual(["peer", "peer_left"]);
  }, 60_000);
});
