import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import { maxFrameBytes, maxRelayMessageBytes } from "@obnixe/core/agent/limits";
import { clientAddress } from "./address.ts";
import { TokenBucket } from "./bucket.ts";
import { parseClientMessage, relayVersion } from "./messages.ts";
import type { BridgeNotice, ClientMessage, PhoneNotice, Refusal, Role } from "./messages.ts";

export interface RelayLimits {
  /** Largest text a phone may send: one protocol frame. */
  readonly maxFrameBytes: number;
  /** Largest message on any socket: a frame inside a bridge envelope. */
  readonly maxMessageBytes: number;
  /** Data queued for one receiver beyond which it is dropped as not reading; at least one message. */
  readonly maxBufferedBytes: number;
  /** Data queued for every receiver at once beyond which the receiver being written to is dropped. */
  readonly maxTotalBufferedBytes: number;
  readonly maxConnections: number;
  readonly maxConnectionsPerAddress: number;
  readonly connectBurst: number;
  readonly connectsPerSecond: number;
  readonly maxRooms: number;
  readonly maxRoomsPerConnection: number;
  readonly maxRoomsPerAddress: number;
  readonly messageBurst: number;
  readonly messagesPerSecond: number;
  readonly byteBurst: number;
  readonly bytesPerSecond: number;
  readonly joinTimeoutMs: number;
  readonly peerWaitMs: number;
  readonly pingIntervalMs: number;
}

/** Sized for one 256 MB machine: about 60 MB of idle sockets at the connection cap plus the buffered data budget. */
export const defaultLimits: RelayLimits = {
  maxFrameBytes,
  maxMessageBytes: maxRelayMessageBytes,
  maxBufferedBytes: 2 * maxRelayMessageBytes,
  maxTotalBufferedBytes: 64 * 1024 * 1024,
  maxConnections: 2000,
  maxConnectionsPerAddress: 16,
  connectBurst: 20,
  connectsPerSecond: 0.5,
  maxRooms: 4000,
  maxRoomsPerConnection: 16,
  maxRoomsPerAddress: 64,
  messageBurst: 200,
  messagesPerSecond: 50,
  byteBurst: 2 * maxRelayMessageBytes,
  bytesPerSecond: 512 * 1024,
  joinTimeoutMs: 10_000,
  peerWaitMs: 30_000,
  pingIntervalMs: 20_000,
};

export interface RelayOptions {
  readonly port: number;
  readonly host?: string;
  /** Number of trusted proxies in front of the relay whose X-Forwarded-For entries are honoured; 0 ignores the header. */
  readonly proxyHops: number;
  readonly limits?: Partial<RelayLimits>;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

export interface RelayStats {
  readonly connections: number;
  readonly rooms: number;
}

interface Connection {
  readonly socket: WebSocket;
  readonly address: string;
  readonly messages: TokenBucket;
  readonly bytes: TokenBucket;
  readonly rooms: Set<string>;
  role: Role | null;
  timer: ReturnType<typeof setTimeout> | null;
  alive: boolean;
}

interface Room {
  bridge: Connection | null;
  phone: Connection | null;
}

type Join = Extract<ClientMessage, { type: "join" }>;

const normalClosure = 1000;
const goingAway = 1001;
const unsupportedData = 1003;
const policyViolation = 1008;
const messageTooBig = 1009;
const shutdownGraceMs = 2000;
const pressureBytes = 64 * 1024;
const socketPath = "/v1";
const healthPath = "/healthz";

function pathOf(url: string | undefined): string {
  return (url ?? "/").split("?")[0] ?? "/";
}

function byteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
  return data.byteLength;
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  socket.on("error", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function decrement(counts: Map<string, number>, key: string): void {
  const count = (counts.get(key) ?? 1) - 1;
  if (count > 0) counts.set(key, count);
  else counts.delete(key);
}

/**
 * Rendezvous relay: pairs at most one bridge and one phone per room and forwards their text frames without reading them.
 * Everything it carries is already sealed end to end, so it only has to stay available and refuse abuse.
 */
export class RelayServer {
  private readonly options: RelayOptions;
  private readonly limits: RelayLimits;
  private readonly now: () => number;
  private readonly connections = new Set<Connection>();
  private readonly connectionsPerAddress = new Map<string, number>();
  private readonly roomsPerAddress = new Map<string, number>();
  private readonly connectBuckets = new Map<string, TokenBucket>();
  private readonly rooms = new Map<string, Room>();
  /** Receivers with a noticeable send queue, the only ones that count toward the total buffered budget. */
  private readonly pressured = new Set<Connection>();
  private http: Server | null = null;
  private sockets: WebSocketServer | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closing = false;

  constructor(options: RelayOptions) {
    this.options = options;
    this.limits = { ...defaultLimits, ...options.limits };
    this.now = options.now ?? Date.now;
  }

  async listen(): Promise<number> {
    const sockets = new WebSocketServer({ noServer: true, maxPayload: this.limits.maxMessageBytes });
    const http = createServer((request, response) => this.respond(request, response));
    http.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(request, socket, head));
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.options.port, this.options.host, () => {
        http.off("error", reject);
        resolve();
      });
    });
    this.http = http;
    this.sockets = sockets;
    this.heartbeat = setInterval(() => this.tick(), this.limits.pingIntervalMs);
    return (http.address() as AddressInfo).port;
  }

  stats(): RelayStats {
    return { connections: this.connections.size, rooms: this.rooms.size };
  }

  /** Stops accepting, tells every client the relay is going away, then closes whatever did not finish in time. */
  async close(): Promise<void> {
    this.closing = true;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    const closed = [...this.connections].map(
      (connection) =>
        new Promise<void>((resolve) => {
          connection.socket.once("close", () => resolve());
          connection.socket.close(goingAway, "shutdown");
        }),
    );
    const grace = new Promise<void>((resolve) => setTimeout(resolve, shutdownGraceMs).unref());
    await Promise.race([Promise.all(closed), grace]);
    for (const connection of this.connections) connection.socket.terminate();
    const sockets = this.sockets;
    if (sockets !== null) await new Promise<void>((resolve) => sockets.close(() => resolve()));
    const http = this.http;
    if (http !== null) {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }

  private respond(request: IncomingMessage, response: ServerResponse): void {
    if (request.method === "GET" && pathOf(request.url) === healthPath) {
      response
        .writeHead(this.closing ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify({ status: this.closing ? "closing" : "ok" }));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const sockets = this.sockets;
    if (pathOf(request.url) !== socketPath) {
      refuseUpgrade(socket, 404, "Not Found");
      return;
    }
    if (sockets === null || this.closing || this.connections.size >= this.limits.maxConnections) {
      refuseUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    const address = clientAddress(request, this.options.proxyHops);
    if ((this.connectionsPerAddress.get(address) ?? 0) >= this.limits.maxConnectionsPerAddress || !this.connectBucket(address).take(1, this.now())) {
      refuseUpgrade(socket, 429, "Too Many Requests");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => this.accept(websocket, address));
  }

  private connectBucket(address: string): TokenBucket {
    const existing = this.connectBuckets.get(address);
    if (existing !== undefined) return existing;
    const bucket = new TokenBucket(this.limits.connectBurst, this.limits.connectsPerSecond, this.now());
    this.connectBuckets.set(address, bucket);
    return bucket;
  }

  private accept(socket: WebSocket, address: string): void {
    const now = this.now();
    const connection: Connection = {
      socket,
      address,
      messages: new TokenBucket(this.limits.messageBurst, this.limits.messagesPerSecond, now),
      bytes: new TokenBucket(this.limits.byteBurst, this.limits.bytesPerSecond, now),
      rooms: new Set(),
      role: null,
      timer: null,
      alive: true,
    };
    connection.timer = setTimeout(() => this.drop(connection, policyViolation, "join timeout"), this.limits.joinTimeoutMs);
    this.connections.add(connection);
    increment(this.connectionsPerAddress, address);
    socket.on("message", (data, isBinary) => this.receive(connection, data, isBinary));
    socket.on("pong", () => {
      connection.alive = true;
    });
    socket.on("close", () => this.closed(connection));
    socket.on("error", (error) => this.options.log(`Connection error: ${error.message}`));
  }

  private receive(connection: Connection, data: RawData, isBinary: boolean): void {
    if (connection.socket.readyState !== connection.socket.OPEN) return;
    if (isBinary) {
      this.drop(connection, unsupportedData, "binary");
      return;
    }
    const now = this.now();
    const size = byteLength(data);
    if (!connection.messages.take(1, now) || !connection.bytes.take(size, now)) {
      this.drop(connection, policyViolation, "rate");
      return;
    }
    if (connection.role === "phone") {
      if (size > this.limits.maxFrameBytes) this.drop(connection, messageTooBig, "frame too large");
      else this.fromPhone(connection, rawText(data));
      return;
    }
    const message = parseClientMessage(rawText(data));
    if (message === null || (connection.role === null && message.type !== "join")) {
      this.drop(connection, policyViolation, "protocol");
      return;
    }
    this.control(connection, message);
  }

  private fromPhone(phone: Connection, text: string): void {
    const [id] = phone.rooms;
    const room = id === undefined ? undefined : this.rooms.get(id);
    if (id === undefined || room === undefined || room.phone !== phone || room.bridge === null) {
      this.drop(phone, policyViolation, "no peer");
      return;
    }
    const notice: BridgeNotice = { type: "frame", room: id, data: text };
    const envelope = JSON.stringify(notice);
    if (Buffer.byteLength(envelope) > this.limits.maxMessageBytes) {
      this.drop(phone, messageTooBig, "frame too large");
      return;
    }
    this.send(room.bridge, envelope);
  }

  private control(bridge: Connection, message: ClientMessage): void {
    switch (message.type) {
      case "join":
        this.join(bridge, message);
        return;
      case "leave":
        this.leave(bridge, message.room);
        return;
      case "frame": {
        if (Buffer.byteLength(message.data) > this.limits.maxFrameBytes) {
          this.drop(bridge, messageTooBig, "frame too large");
          return;
        }
        const room = this.rooms.get(message.room);
        if (room?.bridge === bridge && room.phone !== null) this.send(room.phone, message.data);
        return;
      }
      case "close": {
        const room = this.rooms.get(message.room);
        if (room?.bridge !== bridge || room.phone === null) return;
        const phone = room.phone;
        this.unseat(room, message.room, "phone");
        this.toBridge(bridge, { type: "peer_left", room: message.room });
        this.dismiss(phone);
        return;
      }
      default: {
        const unreachable: never = message;
        throw new Error(`Unhandled client message ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private join(connection: Connection, message: Join): void {
    if (connection.role !== null && connection.role !== message.role) {
      this.drop(connection, policyViolation, "protocol");
      return;
    }
    if (message.v !== relayVersion) {
      this.refuse(connection, message.role, message.room, "version");
      return;
    }
    if (connection.timer !== null) clearTimeout(connection.timer);
    connection.timer = null;
    connection.role = message.role;
    switch (message.role) {
      case "bridge":
        this.joinBridge(connection, message.room);
        return;
      case "phone":
        this.joinPhone(connection, message.room);
        return;
      default: {
        const unreachable: never = message.role;
        throw new Error(`Unhandled role ${String(unreachable)}`);
      }
    }
  }

  private joinBridge(bridge: Connection, id: string): void {
    if (bridge.rooms.has(id)) {
      this.toBridge(bridge, { type: "joined", room: id });
      return;
    }
    const existing = this.rooms.get(id);
    const refusal = existing !== undefined && existing.bridge !== null ? "occupied" : this.capacityRefusal(bridge, existing);
    if (refusal !== null) {
      this.refuse(bridge, "bridge", id, refusal);
      return;
    }
    const room = existing ?? { bridge: null, phone: null };
    this.seat(room, id, "bridge", bridge);
    this.toBridge(bridge, { type: "joined", room: id });
    if (room.phone !== null) this.connect(id, bridge, room.phone);
  }

  /** A new phone takes the slot over, so a phone that roamed is not locked out by its own half-dead socket. */
  private joinPhone(phone: Connection, id: string): void {
    const existing = this.rooms.get(id);
    const refusal = this.capacityRefusal(phone, existing);
    if (refusal !== null) {
      this.refuse(phone, "phone", id, refusal);
      return;
    }
    const room = existing ?? { bridge: null, phone: null };
    const previous = room.phone;
    if (previous !== null) {
      this.unseat(room, id, "phone");
      if (room.bridge !== null) this.toBridge(room.bridge, { type: "peer_left", room: id });
      this.dismiss(previous);
    }
    this.seat(room, id, "phone", phone);
    if (room.bridge !== null) this.connect(id, room.bridge, phone);
    else phone.timer = setTimeout(() => this.drop(phone, normalClosure, "no bridge"), this.limits.peerWaitMs);
  }

  private capacityRefusal(connection: Connection, room: Room | undefined): Refusal | null {
    if (connection.rooms.size >= this.limits.maxRoomsPerConnection) return "rooms";
    if ((this.roomsPerAddress.get(connection.address) ?? 0) >= this.limits.maxRoomsPerAddress) return "rooms";
    if (room === undefined && this.rooms.size >= this.limits.maxRooms) return "busy";
    return null;
  }

  private seat(room: Room, id: string, role: Role, connection: Connection): void {
    switch (role) {
      case "bridge":
        room.bridge = connection;
        break;
      case "phone":
        room.phone = connection;
        break;
      default: {
        const unreachable: never = role;
        throw new Error(`Unhandled role ${String(unreachable)}`);
      }
    }
    this.rooms.set(id, room);
    connection.rooms.add(id);
    increment(this.roomsPerAddress, connection.address);
  }

  /** Frees one slot of a room and deletes the room once both slots are free. */
  private unseat(room: Room, id: string, role: Role): void {
    const connection = role === "bridge" ? room.bridge : room.phone;
    if (connection === null) return;
    if (role === "bridge") room.bridge = null;
    else room.phone = null;
    if (connection.rooms.delete(id)) decrement(this.roomsPerAddress, connection.address);
    if (room.bridge === null && room.phone === null && this.rooms.get(id) === room) this.rooms.delete(id);
  }

  private connect(id: string, bridge: Connection, phone: Connection): void {
    if (phone.timer !== null) clearTimeout(phone.timer);
    phone.timer = null;
    this.toPhone(phone, { type: "peer" });
    this.toBridge(bridge, { type: "peer", room: id });
  }

  private refuse(connection: Connection, role: Role, id: string, reason: Refusal): void {
    switch (role) {
      case "bridge":
        this.toBridge(connection, { type: "refused", room: id, reason });
        return;
      case "phone":
        this.toPhone(connection, { type: "refused", reason });
        this.drop(connection, policyViolation, reason);
        return;
      default: {
        const unreachable: never = role;
        throw new Error(`Unhandled role ${String(unreachable)}`);
      }
    }
  }

  private leave(bridge: Connection, id: string): void {
    const room = this.rooms.get(id);
    if (room?.bridge !== bridge) return;
    const phone = room.phone;
    this.unseat(room, id, "bridge");
    if (phone !== null) {
      this.unseat(room, id, "phone");
      this.dismiss(phone);
    }
  }

  /** Tells a phone its bridge is gone, then closes it: a phone socket serves one bridge session only. */
  private dismiss(phone: Connection): void {
    this.toPhone(phone, { type: "peer_left" });
    this.drop(phone, normalClosure, "peer_left");
  }

  private detach(connection: Connection): void {
    if (connection.timer !== null) clearTimeout(connection.timer);
    connection.timer = null;
    this.pressured.delete(connection);
    for (const id of [...connection.rooms]) {
      const room = this.rooms.get(id);
      if (room === undefined) continue;
      if (room.bridge === connection) {
        const phone = room.phone;
        this.unseat(room, id, "bridge");
        if (phone !== null) {
          this.unseat(room, id, "phone");
          this.dismiss(phone);
        }
      } else if (room.phone === connection) {
        this.unseat(room, id, "phone");
        if (room.bridge !== null) this.toBridge(room.bridge, { type: "peer_left", room: id });
      }
    }
  }

  private drop(connection: Connection, code: number, reason: string): void {
    this.detach(connection);
    connection.socket.close(code, reason);
  }

  private closed(connection: Connection): void {
    this.detach(connection);
    if (this.connections.delete(connection)) decrement(this.connectionsPerAddress, connection.address);
  }

  /** Queues `text` unless the receiver stopped reading; such a receiver is cut off so the relay never buffers without bound. */
  private send(receiver: Connection, text: string): void {
    if (receiver.socket.readyState !== receiver.socket.OPEN) return;
    if (this.overloaded(receiver, Buffer.byteLength(text))) {
      this.options.log(`Dropped a ${receiver.role ?? "client"} that stopped reading.`);
      this.detach(receiver);
      receiver.socket.terminate();
      return;
    }
    receiver.socket.send(text);
  }

  private overloaded(receiver: Connection, size: number): boolean {
    const queued = receiver.socket.bufferedAmount + size;
    if (queued > this.limits.maxBufferedBytes) return true;
    if (queued <= pressureBytes) {
      this.pressured.delete(receiver);
      return false;
    }
    this.pressured.add(receiver);
    let total = size;
    for (const connection of this.pressured) total += connection.socket.bufferedAmount;
    return total > this.limits.maxTotalBufferedBytes;
  }

  private toBridge(bridge: Connection, notice: BridgeNotice): void {
    this.send(bridge, JSON.stringify(notice));
  }

  private toPhone(phone: Connection, notice: PhoneNotice): void {
    this.send(phone, JSON.stringify(notice));
  }

  private tick(): void {
    for (const connection of this.connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
    const now = this.now();
    for (const [address, bucket] of this.connectBuckets) {
      if (!this.connectionsPerAddress.has(address) && bucket.isFull(now)) this.connectBuckets.delete(address);
    }
  }
}
