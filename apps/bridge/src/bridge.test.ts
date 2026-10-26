import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { PhoneSession, SealedChannel, closeConnection, decodeFrame, encodeFrame, openConnection, pairingCodeTtlMs, renameConnectionClient, runAgentTool } from "@obnixe/core";
import type { Frame, PhoneLinkStatus, RejectionReason } from "@obnixe/core";
import { createTestContext } from "@obnixe/core/testing";
import type { TestContext } from "@obnixe/core/testing";
import { agentCall, agentConnection, changeset, session, settings } from "@obnixe/schema";
import type { Id } from "@obnixe/schema";
import { startControl } from "./control.ts";
import type { ControlServer } from "./control.ts";
import { createMcpServer } from "./mcp.ts";
import { postPairingCode } from "./pair.ts";
import { PhoneEndpoint, notConnectedMessage } from "./phone.ts";

const bytes = (length: number): Uint8Array => new Uint8Array(randomBytes(length));

let context: TestContext;
let endpoint: PhoneEndpoint;
let control: ControlServer;
let phonePort: number;
let client: Client;
let skew = 0;
const logs: string[] = [];

interface SimulatedPhone {
  readonly session: PhoneSession;
  readonly socket: WebSocket;
  readonly sent: Frame[];
  readonly statuses: PhoneLinkStatus[];
  readonly rejections: RejectionReason[];
  readonly closeCodes: number[];
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function connectPhone(code: string, host = "127.0.0.1"): SimulatedPhone {
  const socket = new WebSocket(`ws://${host}:${phonePort}`);
  const sent: Frame[] = [];
  const statuses: PhoneLinkStatus[] = [];
  const rejections: RejectionReason[] = [];
  const closeCodes: number[] = [];
  const phoneSession = new PhoneSession({
    code,
    device: "iPhone",
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
  return { session: phoneSession, socket, sent, statuses, rejections, closeCodes };
}

async function pairedPhone(): Promise<SimulatedPhone> {
  const phone = connectPhone("482917");
  await until(() => endpoint.status().phone === "waiting", "hello");
  expect(await postPairingCode(control.port, "482 917")).toEqual({ kind: "paired", device: "iPhone", client: "Cursor" });
  await until(() => phone.statuses.includes("open"), "open session");
  return phone;
}

function connectionRow(connectionId: Id | null) {
  return context.db.select().from(agentConnection).all().find((row) => row.id === connectionId);
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
  skew = 0;
  endpoint = new PhoneEndpoint({
    port: 0,
    listenHost: "::",
    hostLabel: "MacBook Pro",
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
});

afterEach(async () => {
  await client.close();
  await endpoint.close();
  await control.close();
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
    const phone = connectPhone("482917", "[::1]");
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
