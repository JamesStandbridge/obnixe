import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  PhoneSession,
  SealedChannel,
  closeConnection,
  decodeFrame,
  encodeFrame,
  generateIdentity,
  openConnection,
  pairingCodeTtlMs,
  phoneRevocation,
  renameConnectionClient,
  runAgentTool,
} from "@obnixe/core";
import type { Frame, PhoneLinkStatus, PhonePairing, PhoneRevocation, RejectionReason } from "@obnixe/core";
import { createTestContext } from "@obnixe/core/testing";
import type { TestContext } from "@obnixe/core/testing";
import { agentCall, agentConnection, changeset, session, settings } from "@obnixe/schema";
import type { Id } from "@obnixe/schema";
import { startControl } from "./control.ts";
import type { ControlServer } from "./control.ts";
import { postForget, runForget } from "./forget.ts";
import { createMcpServer } from "./mcp.ts";
import { postPairingCode } from "./pair.ts";
import { PairingFile } from "./pairings.ts";
import { PhoneEndpoint, notConnectedMessage } from "./phone.ts";

const bytes = (length: number): Uint8Array => new Uint8Array(randomBytes(length));

let context: TestContext;
let configDir: string;
let pairings: PairingFile;
let endpoint: PhoneEndpoint;
let control: ControlServer;
let phonePort: number;
let client: Client;
let skew = 0;
const logs: string[] = [];
const deviceId = generateIdentity(bytes);

interface SimulatedPhone {
  readonly session: PhoneSession;
  readonly socket: WebSocket;
  readonly sent: Frame[];
  readonly statuses: PhoneLinkStatus[];
  readonly rejections: RejectionReason[];
  readonly paired: PhonePairing[];
  readonly acknowledged: PhoneRevocation[];
  readonly closeCodes: number[];
}

interface PhoneOptions {
  readonly host?: string;
  readonly pairing?: PhonePairing;
  readonly revocation?: PhoneRevocation;
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function connectPhone(code: string, options: PhoneOptions = {}): SimulatedPhone {
  const socket = new WebSocket(`ws://${options.host ?? "127.0.0.1"}:${phonePort}`);
  const sent: Frame[] = [];
  const statuses: PhoneLinkStatus[] = [];
  const rejections: RejectionReason[] = [];
  const paired: PhonePairing[] = [];
  const acknowledged: PhoneRevocation[] = [];
  const closeCodes: number[] = [];
  const phoneSession = new PhoneSession({
    code,
    device: "iPhone",
    deviceId,
    pairing: options.pairing ?? null,
    revocation: options.revocation ?? null,
    randomBytes: bytes,
    now: Date.now,
    socket: {
      send: (text) => {
        sent.push(decodeFrame(text));
        socket.send(text);
      },
      close: () => socket.close(),
    },
    handlers: {
      onStatus: (status) => statuses.push(status),
      onOpen: (peer) => openConnection(context.db, context.env, peer),
      onClient: (connectionId, name) => renameConnectionClient(context.db, connectionId, name),
      onCall: (connectionId, tool, args) => runAgentTool(context.db, context.env, { connectionId, tool, arguments: args, timeZone: "Europe/Paris" }),
      onRejected: (reason) => rejections.push(reason),
      onPaired: (pairing) => paired.push(pairing),
      onRevocationAcknowledged: (revocation) => acknowledged.push(revocation),
    },
  });
  socket.on("message", (data) => {
    void phoneSession.receive(String(data));
  });
  socket.on("close", (closeCode) => {
    closeCodes.push(closeCode);
    const connectionId = phoneSession.connectionId;
    if (connectionId !== null && !phoneSession.isClosed) closeConnection(context.db, context.env, connectionId, "network");
    phoneSession.markClosed();
  });
  return { session: phoneSession, socket, sent, statuses, rejections, paired, acknowledged, closeCodes };
}

async function pairedPhone(): Promise<SimulatedPhone> {
  const phone = connectPhone("482917");
  await until(() => endpoint.status().phone === "waiting", "hello");
  expect(await postPairingCode(control.port, "482 917")).toEqual({ kind: "paired", device: "iPhone", client: "Cursor" });
  await until(() => phone.statuses.includes("open"), "open session");
  return phone;
}

function storedPairing(phone: SimulatedPhone): PhonePairing {
  const [pairing] = phone.paired;
  if (pairing === undefined) throw new Error("The phone stored no pairing");
  return pairing;
}

async function resumedPhone(pairing: PhonePairing): Promise<SimulatedPhone> {
  const phone = connectPhone("000000", { pairing });
  await until(() => phone.statuses.includes("open"), "resumed session");
  return phone;
}

function connectionRow(connectionId: Id | null) {
  return context.db.select().from(agentConnection).all().find((row) => row.id === connectionId);
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = (result as CallToolResult).content;
  return first?.type === "text" ? first.text : "";
}

async function startBridge(): Promise<void> {
  endpoint = new PhoneEndpoint({
    port: 0,
    listenHost: "::",
    hostLabel: "MacBook Pro",
    pairings,
    randomBytes: bytes,
    log: (line) => logs.push(line),
    now: () => Date.now() + skew,
    callTimeoutMs: 5000,
    handshakeTimeoutMs: 1000,
  });
  phonePort = await endpoint.listen();
  control = await startControl(endpoint, 0);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer(endpoint).connect(serverTransport);
  client = new Client({ name: "cursor-vscode", version: "1.0.0" });
  await client.connect(clientTransport);
  await until(() => endpoint.status().client === "Cursor", "client name");
}

async function stopBridge(): Promise<void> {
  await client.close();
  await endpoint.close();
  await control.close();
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
  skew = 0;
  configDir = mkdtempSync(join(tmpdir(), "obnixe-bridge-"));
  pairings = new PairingFile(join(configDir, "obnixe", "bridge.json"), bytes);
  await startBridge();
});

afterEach(async () => {
  await stopBridge();
  rmSync(configDir, { recursive: true, force: true });
});

describe("MCP surface", () => {
  it("registers every shared tool with its JSON schema and hints", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_sports",
      "get_history",
      "get_exercise_progress",
      "get_body_signals",
      "list_photos",
      "list_programs",
      "get_program",
      "list_exercises",
      "create_exercise",
      "upsert_program",
      "log_activity",
      "log_strength_session",
      "get_next_session",
      "list_agent_changes",
      "log_check_in",
      "report_pain",
      "log_weigh_in",
      "log_measurements",
      "update_session",
      "update_strength_session",
      "delete_session",
      "update_exercise",
      "merge_exercises",
      "set_program_status",
    ]);
    const history = tools.find((tool) => tool.name === "get_history");
    expect(history?.inputSchema.required).toEqual(["from", "to"]);
    expect(history?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "log_activity")?.annotations?.readOnlyHint).toBe(false);
  });

  it("answers with a tool error while no phone is paired", async () => {
    const result = await client.callTool({ name: "list_sports", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(notConnectedMessage);
  });
});

describe("pairing", () => {
  it("rejects wrong codes, limits attempts and never accepts sealed frames before pairing", async () => {
    expect(await postPairingCode(control.port, "482917")).toEqual({ kind: "no_phone" });
    const phone = connectPhone("482917");
    await until(() => endpoint.status().phone === "waiting", "hello");
    expect(await postPairingCode(control.port, "12345")).toEqual({ kind: "invalid_code" });
    for (let remaining = 4; remaining > 0; remaining -= 1) expect(await postPairingCode(control.port, "000000")).toEqual({ kind: "bad_code", remaining });
    expect(await postPairingCode(control.port, "000000")).toEqual({ kind: "bad_code", remaining: 0 });
    await until(() => phone.rejections.includes("code"), "rejection");
    expect(await postPairingCode(control.port, "482917")).toEqual({ kind: "no_phone" });

    const intruder = new WebSocket(`ws://127.0.0.1:${phonePort}`);
    const closed = new Promise<number>((resolve) => intruder.on("close", (code) => resolve(code)));
    intruder.on("open", () => intruder.send(encodeFrame(new SealedChannel(bytes(32), bytes(32)).seal({ jsonrpc: "2.0", id: 1, result: {} }))));
    expect(await closed).toBe(1008);
  });

  it("refuses control requests that a browser could forge", async () => {
    const plain = await fetch(`http://127.0.0.1:${control.port}/pair`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ code: "482917" }) });
    expect(plain.status).toBe(415);
    const status = await fetch(`http://127.0.0.1:${control.port}/status`);
    expect(await status.json()).toEqual({ phone: "none", device: null, client: "Cursor" });
  });

  it("rejects a replayed hello and proof", async () => {
    const original = await pairedPhone();
    const hello = original.sent.find((frame) => frame.type === "hello");
    const proof = original.sent.find((frame) => frame.type === "proof");
    if (hello === undefined || proof === undefined) throw new Error("Expected a recorded hello and proof");
    const replayer = new WebSocket(`ws://127.0.0.1:${phonePort}`);
    replayer.on("message", (data) => {
      const frame = decodeFrame(String(data));
      if (frame.type === "challenge") replayer.send(encodeFrame(hello));
      if (frame.type === "commit") replayer.send(encodeFrame(proof));
    });
    await until(() => logs.filter((line) => line.includes("is waiting to pair")).length === 2, "replayed hello");
    expect(await postPairingCode(control.port, "482917")).toEqual({ kind: "bad_code", remaining: 4 });
    expect(endpoint.status()).toEqual({ phone: "connected", device: "iPhone", client: "Cursor" });
    replayer.close();
  });

  it("keeps a waiting phone through a connection flood from another address", async () => {
    const phone = connectPhone("482917", { host: "[::1]" });
    await until(() => endpoint.status().phone === "waiting", "hello");
    const flood = Array.from({ length: 12 }, () => new WebSocket(`ws://127.0.0.1:${phonePort}`));
    const floodClosed = flood.map((socket) => new Promise<void>((resolve) => socket.on("close", () => resolve())));
    await Promise.all(flood.map((socket) => new Promise<void>((resolve) => socket.on("open", () => resolve()))));
    expect(phone.rejections).toEqual([]);
    expect(await postPairingCode(control.port, "482917")).toEqual({ kind: "paired", device: "iPhone", client: "Cursor" });
    await until(() => phone.statuses.includes("open"), "open session");
    await Promise.all(floodClosed);
  });

  it("drops sockets that never say hello", async () => {
    const idle = new WebSocket(`ws://127.0.0.1:${phonePort}`);
    const closed = new Promise<void>((resolve) => idle.on("close", () => resolve()));
    await closed;
    expect(await postPairingCode(control.port, "482917")).toEqual({ kind: "no_phone" });
  });

  it("expires a hello that waited too long", async () => {
    const phone = connectPhone("482917");
    await until(() => endpoint.status().phone === "waiting", "hello");
    skew = pairingCodeTtlMs + 1;
    expect(await postPairingCode(control.port, "482917")).toEqual({ kind: "no_phone" });
    await until(() => phone.rejections.includes("expired"), "expiry");
  });
});

describe("trusted reconnection", () => {
  it("keeps the bridge identity and the pairing in a private file", async () => {
    const phone = await pairedPhone();
    const pairing = storedPairing(phone);
    expect(statSync(pairings.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(configDir, "obnixe")).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(readFileSync(pairings.path, "utf8")) as { bridgeId: string; pairings: { pairingId: string; deviceId: string; device: string; secret: string }[] };
    expect(stored.bridgeId).toBe(pairing.bridgeId);
    expect(stored.pairings).toEqual([expect.objectContaining({ pairingId: pairing.pairingId, deviceId, device: "iPhone", secret: pairing.secret })]);
    expect(pairing.bridgeName).toBe("MacBook Pro");
    const reloaded = new PairingFile(pairings.path, bytes);
    expect(reloaded.bridgeId()).toBe(pairing.bridgeId);
    expect(reloaded.lookup(pairing.pairingId).kind).toBe("known");
  });

  it("resumes without a code after the phone leaves and after a bridge restart, as new connections", async () => {
    const first = await pairedPhone();
    const pairing = storedPairing(first);
    const firstConnection = first.session.connectionId;
    if (firstConnection === null) throw new Error("No connection");
    closeConnection(context.db, context.env, firstConnection, "screen_closed");
    first.session.close("screen_closed");
    await until(() => endpoint.status().phone === "none", "bridge drop");

    const second = await resumedPhone(pairing);
    expect(second.statuses).toEqual(["resuming", "open"]);
    expect(second.sent.some((frame) => frame.type === "hello")).toBe(false);
    expect(second.paired).toEqual([]);
    expect(endpoint.status()).toEqual({ phone: "connected", device: "iPhone", client: "Cursor" });
    expect((await client.callTool({ name: "list_sports", arguments: {} })).isError).toBe(false);

    await stopBridge();
    await until(() => second.closeCodes.length > 0, "socket close on restart");
    expect(connectionRow(second.session.connectionId)?.endReason).toBe("network");
    await startBridge();
    const third = await resumedPhone(pairing);
    expect((await client.callTool({ name: "list_programs", arguments: {} })).isError).toBe(false);
    const ids = [firstConnection, second.session.connectionId, third.session.connectionId];
    expect(new Set(ids).size).toBe(3);
    expect(connectionRow(firstConnection)?.endReason).toBe("screen_closed");
    expect(connectionRow(third.session.connectionId)).toMatchObject({ client: "Cursor", host: "MacBook Pro", endedAt: null });
    expect(logs.filter((line) => line.startsWith("Reconnected to iPhone without a code")).length).toBe(2);
  });

  it("rejects an unknown pairing and a forged secret with reason unknown", async () => {
    const pairing = storedPairing(await pairedPhone());
    const unknown = connectPhone("000000", { pairing: { ...pairing, pairingId: generateIdentity(bytes) } });
    await until(() => unknown.rejections.length > 0, "unknown rejection");
    expect(unknown.rejections).toEqual(["unknown"]);
    const forged = connectPhone("000000", { pairing: { ...pairing, secret: Buffer.from(bytes(32)).toString("base64") } });
    await until(() => forged.rejections.length > 0, "forged rejection");
    expect(forged.rejections).toEqual(["unknown"]);
    expect(forged.sent.some((frame) => frame.type === "sealed")).toBe(false);
    expect(endpoint.status().device).toBe("iPhone");
  });

  it("refuses a replayed resume frame", async () => {
    const pairing = storedPairing(await pairedPhone());
    const resumed = await resumedPhone(pairing);
    const recorded = resumed.sent.find((frame) => frame.type === "resume");
    if (recorded === undefined) throw new Error("Expected a recorded resume");
    const replayer = new WebSocket(`ws://127.0.0.1:${phonePort}`);
    const answers: Frame[] = [];
    replayer.on("message", (data) => {
      const frame = decodeFrame(String(data));
      answers.push(frame);
      if (frame.type === "challenge") replayer.send(encodeFrame(recorded));
    });
    await until(() => answers.length === 2, "replay answer");
    expect(answers[1]).toEqual({ type: "rejected", reason: "unknown" });
    expect(endpoint.status().phone).toBe("connected");
  });

  it("forgets every pairing on demand, ends the trusted session and then answers revoked", async () => {
    const phone = await pairedPhone();
    const pairing = storedPairing(phone);
    expect(await postForget(control.port)).toEqual({ devices: ["iPhone"] });
    await until(() => phone.closeCodes.length > 0, "forgotten session closed");
    expect(endpoint.status().phone).toBe("none");
    const again = connectPhone("000000", { pairing });
    await until(() => again.rejections.length > 0, "revoked rejection");
    expect(again.rejections).toEqual(["revoked"]);
    expect(await postForget(control.port)).toEqual({ devices: [] });
  });

  it("drops a pairing the phone revoked before pairing again with a code", async () => {
    const pairing = storedPairing(await pairedPhone());
    const revocation = phoneRevocation(pairing);
    const phone = connectPhone("482917", { revocation });
    await until(() => logs.some((line) => line.includes("forgot this Mac")), "revocation log");
    expect(pairings.list()).toEqual([]);
    expect(pairings.lookup(pairing.pairingId).kind).toBe("revoked");
    expect(phone.acknowledged).toEqual([]);
    expect(await postPairingCode(control.port, "482917")).toEqual({ kind: "paired", device: "iPhone", client: "Cursor" });
    await until(() => phone.statuses.includes("open"), "new pairing");
    expect(phone.acknowledged).toEqual([revocation]);
    expect(storedPairing(phone).pairingId).not.toBe(pairing.pairingId);
    expect(pairings.list().map((entry) => entry.pairingId)).toEqual([storedPairing(phone).pairingId]);
  });

  it("forgets from the file when no bridge is running", async () => {
    await pairedPhone();
    await stopBridge();
    const output = new PassThrough();
    expect(await runForget({ controlPort: control.port, pairings, output })).toBe(0);
    expect(String(output.read())).toBe("Forgot iPhone. The phone will ask for a new code.\n");
    expect(pairings.list()).toEqual([]);
    await startBridge();
  });
});

describe("relayed tool calls", () => {
  it("records the connection, gates writes and journals them as the agent", async () => {
    const phone = await pairedPhone();
    const connectionId = phone.session.connectionId;
    if (connectionId === null) throw new Error("No connection");
    expect(connectionRow(connectionId)).toMatchObject({ client: "Cursor", host: "MacBook Pro", endedAt: null });

    const sports = await client.callTool({ name: "list_sports", arguments: {} });
    expect(sports.isError).toBe(false);
    expect(JSON.parse(textOf(sports)).catalogVersion).toBe(1);

    const activity = { sport: "run", startedAt: "2026-10-12T18:00:00+02:00", durationSeconds: 2700, values: { distance: 9200, kind: "intervals" } };
    const denied = await client.callTool({ name: "log_activity", arguments: activity });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("Modifier directement");

    context.db.update(settings).set({ agentCanWrite: true }).run();
    const logged = await client.callTool({ name: "log_activity", arguments: activity });
    expect(logged.isError).toBe(false);
    const sessionId = (JSON.parse(textOf(logged)) as { sessionId: Id }).sessionId;
    expect(context.db.select().from(session).all().find((row) => row.id === sessionId)?.values).toEqual({ distance: 9200, kind: "intervals" });
    const write = context.db.select().from(agentCall).all().find((row) => row.tool === "log_activity");
    expect(write).toMatchObject({ connectionId, kind: "write", summary: "Course du 12 octobre · 9,2 km" });
    expect(context.db.select().from(changeset).all().find((row) => row.id === write?.changesetId)).toMatchObject({ author: "agent", connectionId });

    const invalid = await client.callTool({ name: "get_history", arguments: { from: "2026-10-01" } });
    expect(invalid.isError).toBe(true);
    const catalog = await client.callTool({ name: "log_activity", arguments: { ...activity, values: { distance: -3 } } });
    expect(catalog.isError).toBe(true);
    expect(context.db.select().from(agentCall).all().map((row) => row.tool)).toEqual(["list_sports", "log_activity"]);
  });

  it("ends the session when the phone leaves", async () => {
    const phone = await pairedPhone();
    const connectionId = phone.session.connectionId;
    if (connectionId === null) throw new Error("No connection");
    closeConnection(context.db, context.env, connectionId, "user");
    phone.session.close("user");
    await until(() => endpoint.status().phone === "none", "bridge drop");
    const after = await client.callTool({ name: "list_programs", arguments: {} });
    expect(after.isError).toBe(true);
    expect(textOf(after)).toBe(notConnectedMessage);
    expect(connectionRow(connectionId)?.endReason).toBe("user");
    expect(logs.some((line) => line.includes("The phone ended the connection (user)"))).toBe(true);
  });

  it("marks the connection as dropped when the socket dies", async () => {
    const phone = await pairedPhone();
    const connectionId = phone.session.connectionId;
    await endpoint.close();
    await until(() => phone.closeCodes.length > 0, "socket close");
    expect(connectionRow(connectionId)?.endReason).toBe("network");
  });

  it("frames survive a round trip through the wire codec", () => {
    expect(decodeFrame(encodeFrame({ type: "rejected", reason: "expired" }))).toEqual({ type: "rejected", reason: "expired" });
  });
});
