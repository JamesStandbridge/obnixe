import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ClientOptions } from "ws";
import { RelayServer } from "./server.ts";
import type { RelayLimits } from "./server.ts";

interface Closed {
  readonly code: number;
  readonly reason: string;
}

interface TestClient {
  readonly socket: WebSocket;
  readonly received: string[];
  readonly closed: Promise<Closed>;
  readonly send: (message: unknown) => void;
  readonly nth: (index: number) => Promise<unknown>;
}

let server: RelayServer | null = null;
let port = 0;
const clients: WebSocket[] = [];

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function start(limits: Partial<RelayLimits> = {}, proxyHops = 0): Promise<void> {
  server = new RelayServer({ port: 0, host: "127.0.0.1", proxyHops, limits, log: () => undefined });
  port = await server.listen();
}

function room(): string {
  return randomBytes(32).toString("base64url");
}

function open(options: ClientOptions = {}, path = "/v1"): WebSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, options);
  clients.push(socket);
  return socket;
}

async function connect(options: ClientOptions = {}): Promise<TestClient> {
  const socket = open(options);
  const received: string[] = [];
  socket.on("message", (data) => received.push(String(data)));
  const closed = new Promise<Closed>((resolve) => socket.on("close", (code, reason) => resolve({ code, reason: String(reason) })));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return {
    socket,
    received,
    closed,
    send: (message) => socket.send(typeof message === "string" ? message : JSON.stringify(message)),
    nth: async (index) => {
      await until(() => received.length > index, `message ${index}`);
      const text = received[index] ?? "";
      return text.startsWith("{") ? JSON.parse(text) : text;
    },
  };
}

async function refusedStatus(options: ClientOptions = {}, path = "/v1"): Promise<string> {
  const socket = open(options, path);
  return new Promise<string>((resolve) => socket.once("error", (error) => resolve(error.message)));
}

async function bridgeIn(...rooms: string[]): Promise<TestClient> {
  const bridge = await connect();
  for (const id of rooms) bridge.send({ type: "join", v: 1, role: "bridge", room: id });
  await until(() => bridge.received.filter((text) => text.includes('"joined"')).length === rooms.length, "joined");
  return bridge;
}

async function phoneIn(id: string): Promise<TestClient> {
  const phone = await connect();
  phone.send({ type: "join", v: 1, role: "phone", room: id });
  return phone;
}

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.terminate();
  await server?.close();
  server = null;
});

describe("rendezvous", () => {
  it("pairs one bridge and one phone per room and forwards text both ways verbatim", async () => {
    await start();
    const id = room();
    const bridge = await bridgeIn(id);
    expect(await bridge.nth(0)).toEqual({ type: "joined", room: id });
    const phone = await phoneIn(id);
    expect(await phone.nth(0)).toEqual({ type: "peer" });
    expect(await bridge.nth(1)).toEqual({ type: "peer", room: id });
    const challenge = JSON.stringify({ type: "challenge", version: 2, bridge: "AA==", nonce: "AA==", key: "AA==" });
    bridge.send({ type: "frame", room: id, data: challenge });
    await until(() => phone.received.length === 2, "frame to phone");
    expect(phone.received[1]).toBe(challenge);
    phone.send("not even json");
    expect(await bridge.nth(2)).toEqual({ type: "frame", room: id, data: "not even json" });
    expect(server?.stats()).toEqual({ connections: 2, rooms: 1 });
  });

  it("lets the phone arrive first and keeps the rooms of one bridge apart", async () => {
    await start();
    const first = room();
    const second = room();
    const early = await phoneIn(first);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(early.received).toEqual([]);
    const bridge = await bridgeIn(first, second);
    expect(await early.nth(0)).toEqual({ type: "peer" });
    const late = await phoneIn(second);
    expect(await late.nth(0)).toEqual({ type: "peer" });
    bridge.send({ type: "frame", room: second, data: "to second" });
    bridge.send({ type: "frame", room: first, data: "to first" });
    await until(() => early.received.length === 2 && late.received.length === 2, "routed frames");
    expect(early.received[1]).toBe("to first");
    expect(late.received[1]).toBe("to second");
  });

  it("refuses a second bridge but lets a new phone take the phone slot over", async () => {
    await start();
    const id = room();
    const bridge = await bridgeIn(id);
    const phone = await phoneIn(id);
    await phone.nth(0);
    const intruder = await connect();
    intruder.send({ type: "join", v: 1, role: "bridge", room: id });
    expect(await intruder.nth(0)).toEqual({ type: "refused", room: id, reason: "occupied" });
    const roamed = await phoneIn(id);
    expect(await roamed.nth(0)).toEqual({ type: "peer" });
    expect(await phone.closed).toEqual({ code: 1000, reason: "peer_left" });
    expect(phone.received.at(-1)).toBe(JSON.stringify({ type: "peer_left" }));
    expect(await bridge.nth(2)).toEqual({ type: "peer_left", room: id });
    expect(await bridge.nth(3)).toEqual({ type: "peer", room: id });
    bridge.send({ type: "frame", room: id, data: "to the roamed phone" });
    await until(() => roamed.received.length === 2, "frame to the new phone");
    expect(roamed.received[1]).toBe("to the roamed phone");
    expect(intruder.received).toHaveLength(1);
  });

  it("tells the bridge a phone left and pairs the next phone in the same room", async () => {
    await start();
    const id = room();
    const bridge = await bridgeIn(id);
    const phone = await phoneIn(id);
    await phone.nth(0);
    phone.socket.close();
    expect(await bridge.nth(2)).toEqual({ type: "peer_left", room: id });
    const next = await phoneIn(id);
    expect(await next.nth(0)).toEqual({ type: "peer" });
    expect(await bridge.nth(3)).toEqual({ type: "peer", room: id });
  });

  it("sends peer_left to the phone and closes it when its bridge leaves, hangs up or disconnects", async () => {
    await start();
    const [left, hungUp, gone] = [room(), room(), room()];
    const bridge = await bridgeIn(left, hungUp, gone);
    const phones = await Promise.all([phoneIn(left), phoneIn(hungUp), phoneIn(gone)]);
    await Promise.all(phones.map((phone) => phone.nth(0)));
    bridge.send({ type: "leave", room: left });
    bridge.send({ type: "close", room: hungUp });
    await until(() => bridge.received.some((text) => text === JSON.stringify({ type: "peer_left", room: hungUp })), "hang up notice");
    bridge.socket.close();
    for (const phone of phones) {
      expect(await phone.closed).toEqual({ code: 1000, reason: "peer_left" });
      expect(phone.received.at(-1)).toBe(JSON.stringify({ type: "peer_left" }));
    }
    await until(() => server?.stats().rooms === 0, "rooms released");
  });
});

describe("refusals and limits", () => {
  it("closes clients that send binary, garbage, frames before a peer or an unsupported version", async () => {
    await start();
    const binary = await connect();
    binary.socket.send(Buffer.from([1, 2, 3]));
    expect((await binary.closed).code).toBe(1003);
    const garbage = await connect();
    garbage.send({ type: "frame", room: room(), data: "x" });
    expect((await garbage.closed).code).toBe(1008);
    const waiting = await phoneIn(room());
    waiting.send("too early");
    expect(await waiting.closed).toEqual({ code: 1008, reason: "no peer" });
    const future = await connect();
    future.send({ type: "join", v: 2, role: "phone", room: room() });
    expect(await future.nth(0)).toEqual({ type: "refused", reason: "version" });
    const badRoom = await connect();
    badRoom.send({ type: "join", v: 1, role: "phone", room: "short" });
    expect((await badRoom.closed).code).toBe(1008);
  });

  it("closes connections exceeding the frame size or the message rate", async () => {
    await start({ maxFrameBytes: 1024, maxMessageBytes: 1500, messageBurst: 5, messagesPerSecond: 1 });
    const id = room();
    const bridge = await bridgeIn(id);
    const phone = await phoneIn(id);
    await phone.nth(0);
    phone.send("x".repeat(1200));
    expect(await phone.closed).toEqual({ code: 1009, reason: "frame too large" });
    const quoted = await phoneIn(id);
    await quoted.nth(0);
    quoted.send('"'.repeat(1000));
    expect(await quoted.closed).toEqual({ code: 1009, reason: "frame too large" });
    expect(bridge.socket.readyState).toBe(WebSocket.OPEN);
    await until(() => bridge.received.some((text) => text.includes("peer_left")), "peer_left after oversize");
    for (let index = 0; index < 10; index += 1) bridge.send({ type: "join", v: 1, role: "bridge", room: id });
    expect(await bridge.closed).toEqual({ code: 1008, reason: "rate" });
  });

  it("limits rooms per connection, connections per address and connection attempts", async () => {
    await start({ maxRoomsPerConnection: 2, maxConnectionsPerAddress: 2, connectBurst: 2, connectsPerSecond: 0.001 });
    const bridge = await bridgeIn(room(), room());
    const third = room();
    bridge.send({ type: "join", v: 1, role: "bridge", room: third });
    expect(await bridge.nth(2)).toEqual({ type: "refused", room: third, reason: "rooms" });
    const second = await connect();
    expect(await refusedStatus()).toBe("Unexpected server response: 429");
    second.socket.close();
    await second.closed;
    await until(() => server?.stats().connections === 1, "second connection released");
    expect(await refusedStatus()).toBe("Unexpected server response: 429");
  });

  it("caps the rooms held from one address", async () => {
    await start({ maxRoomsPerAddress: 3 });
    const bridge = await bridgeIn(room(), room());
    const phone = await phoneIn(room());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fourth = room();
    bridge.send({ type: "join", v: 1, role: "bridge", room: fourth });
    expect(await bridge.nth(2)).toEqual({ type: "refused", room: fourth, reason: "rooms" });
    const another = await phoneIn(room());
    expect(await another.nth(0)).toEqual({ type: "refused", reason: "rooms" });
    phone.socket.close();
    await until(() => server?.stats().rooms === 2, "phone room released");
    bridge.send({ type: "join", v: 1, role: "bridge", room: fourth });
    expect(await bridge.nth(3)).toEqual({ type: "joined", room: fourth });
  });

  it("honours X-Forwarded-For only behind a trusted proxy", async () => {
    await start({ maxConnectionsPerAddress: 1 }, 1);
    await connect({ headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.1" } });
    await connect({ headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.2" } });
    expect(await refusedStatus({ headers: { "x-forwarded-for": "203.0.113.1" } })).toBe("Unexpected server response: 429");
    await server?.close();
    await start({ maxConnectionsPerAddress: 1 });
    await connect({ headers: { "x-forwarded-for": "203.0.113.1" } });
    expect(await refusedStatus({ headers: { "x-forwarded-for": "203.0.113.2" } })).toBe("Unexpected server response: 429");
  });
});

describe("backpressure", () => {
  const chunk = "x".repeat(60 * 1024);
  const unthrottled = { maxFrameBytes: 64 * 1024, maxMessageBytes: 80 * 1024, messageBurst: 100_000, messagesPerSecond: 100_000, byteBurst: 1e10, bytesPerSecond: 1e10 };

  it("cuts off a phone that stops reading and tells its bridge", async () => {
    await start({ ...unthrottled, maxBufferedBytes: 256 * 1024 });
    const id = room();
    const bridge = await bridgeIn(id);
    const phone = await phoneIn(id);
    await phone.nth(0);
    phone.socket.pause();
    for (let index = 0; index < 2000 && !bridge.received.some((text) => text.includes("peer_left")); index += 1) {
      bridge.send({ type: "frame", room: id, data: chunk });
      if (index % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await until(() => bridge.received.some((text) => text.includes("peer_left")), "peer_left for the stalled phone");
    await until(() => server?.stats().connections === 1, "stalled phone dropped");
    expect(bridge.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("cuts off a bridge that stops reading once the total buffered budget is spent", async () => {
    await start({ ...unthrottled, maxBufferedBytes: 1024 * 1024 * 1024, maxTotalBufferedBytes: 256 * 1024 });
    const id = room();
    const bridge = await bridgeIn(id);
    const phone = await phoneIn(id);
    await phone.nth(0);
    bridge.socket.pause();
    for (let index = 0; index < 2000 && !phone.received.some((text) => text.includes("peer_left")); index += 1) {
      phone.send(chunk);
      if (index % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await phone.closed).toEqual({ code: 1000, reason: "peer_left" });
    await until(() => server?.stats().connections === 0 && server.stats().rooms === 0, "stalled bridge dropped");
  });
});

describe("timeouts", () => {
  it("drops sockets that never join and phones whose bridge never comes", async () => {
    await start({ joinTimeoutMs: 100, peerWaitMs: 150 });
    const silent = await connect();
    expect(await silent.closed).toEqual({ code: 1008, reason: "join timeout" });
    const lonely = await phoneIn(room());
    expect(await lonely.closed).toEqual({ code: 1000, reason: "no bridge" });
    await until(() => server?.stats().connections === 0 && server.stats().rooms === 0, "everything released");
  });

  it("terminates peers that stop answering pings and reports it to the other side", async () => {
    await start({ pingIntervalMs: 50 });
    const id = room();
    const bridge = await bridgeIn(id);
    const phone = await connect({ autoPong: false });
    phone.send({ type: "join", v: 1, role: "phone", room: id });
    await phone.nth(0);
    expect((await phone.closed).code).toBe(1006);
    await until(() => bridge.received.some((text) => text.includes("peer_left")), "peer_left after idle");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(bridge.socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe("http", () => {
  it("answers health checks, refuses other paths and says goodbye on shutdown", async () => {
    await start();
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect((await fetch(`http://127.0.0.1:${port}/v1`)).status).toBe(404);
    expect(await refusedStatus({}, "/v2")).toBe("Unexpected server response: 404");
    const client = await connect();
    await server?.close();
    server = null;
    expect((await client.closed).code).toBe(1001);
  });
});
