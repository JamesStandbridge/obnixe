import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import { clientAddress } from "./address.ts";
import { TokenBucket } from "./bucket.ts";
import { parseClientMessage, relayVersion } from "./messages.ts";
import type { BridgeNotice, ClientMessage, PhoneNotice, Refusal, Role } from "./messages.ts";

export interface RelayLimits {
  readonly maxFrameBytes: number;
  readonly maxConnections: number;
  readonly maxConnectionsPerAddress: number;
  readonly connectBurst: number;
  readonly connectsPerSecond: number;
  readonly maxRooms: number;
  readonly maxRoomsPerConnection: number;
  readonly messageBurst: number;
  readonly messagesPerSecond: number;
  readonly byteBurst: number;
  readonly bytesPerSecond: number;
  readonly joinTimeoutMs: number;
  readonly peerWaitMs: number;
  readonly pingIntervalMs: number;
}

export const defaultLimits: RelayLimits = {
  maxFrameBytes: 256 * 1024,
  maxConnections: 10_000,
  maxConnectionsPerAddress: 32,
  connectBurst: 20,
  connectsPerSecond: 0.5,
  maxRooms: 20_000,
  maxRoomsPerConnection: 16,
  messageBurst: 200,
  messagesPerSecond: 50,
  byteBurst: 2 * 1024 * 1024,
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
const shutdownGraceMs = 2000;
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

/**
 * Rendezvous relay: pairs at most one bridge and one phone per room and forwards their text frames without reading them.
 * Everything it carries is already sealed end to end, so it only has to stay available and refuse abuse.
 */
export class RelayServer {
  private readonly options: RelayOptions;
  private readonly limits: RelayLimits;
  private readonly now: () => number;
  private readonly connections = new Set<Connection>();
  private readonly perAddress = new Map<string, number>();
  private readonly connectBuckets = new Map<string, TokenBucket>();
  private readonly rooms = new Map<string, Room>();
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
    const sockets = new WebSocketServer({ noServer: true, maxPayload: this.limits.maxFrameBytes });
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
    if ((this.perAddress.get(address) ?? 0) >= this.limits.maxConnectionsPerAddress || !this.connectBucket(address).take(1, this.now())) {
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
    this.perAddress.set(address, (this.perAddress.get(address) ?? 0) + 1);
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
    if (!connection.messages.take(1, now) || !connection.bytes.take(byteLength(data), now)) {
      this.drop(connection, policyViolation, "rate");
      return;
    }
    const text = rawText(data);
    if (connection.role === "phone") {
      this.fromPhone(connection, text);
      return;
    }
    const message = parseClientMessage(text);
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
    this.toBridge(room.bridge, { type: "frame", room: id, data: text });
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
        const room = this.rooms.get(message.room);
        if (room?.bridge === bridge && room.phone !== null) this.send(room.phone, message.data);
        return;
      }
      case "close": {
        const room = this.rooms.get(message.room);
        if (room?.bridge !== bridge || room.phone === null) return;
        const phone = room.phone;
        room.phone = null;
        phone.rooms.delete(message.room);
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
    const refusal = this.refusalFor(existing, "bridge", bridge.rooms.size >= this.limits.maxRoomsPerConnection);
    if (refusal !== null) {
      this.refuse(bridge, "bridge", id, refusal);
      return;
    }
    const room = existing ?? { bridge: null, phone: null };
    room.bridge = bridge;
    this.rooms.set(id, room);
    bridge.rooms.add(id);
    this.toBridge(bridge, { type: "joined", room: id });
    if (room.phone !== null) this.connect(id, bridge, room.phone);
  }

  private joinPhone(phone: Connection, id: string): void {
    const existing = this.rooms.get(id);
    const refusal = this.refusalFor(existing, "phone", false);
    if (refusal !== null) {
      this.refuse(phone, "phone", id, refusal);
      return;
    }
    const room = existing ?? { bridge: null, phone: null };
    room.phone = phone;
    this.rooms.set(id, room);
    phone.rooms.add(id);
    if (room.bridge !== null) this.connect(id, room.bridge, phone);
    else phone.timer = setTimeout(() => this.drop(phone, normalClosure, "no bridge"), this.limits.peerWaitMs);
  }

  private refusalFor(room: Room | undefined, role: Role, tooManyRooms: boolean): Refusal | null {
    if (tooManyRooms) return "rooms";
    if (room === undefined) return this.rooms.size >= this.limits.maxRooms ? "busy" : null;
    const holder = role === "bridge" ? room.bridge : room.phone;
    return holder === null ? null : "occupied";
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
    if (!bridge.rooms.delete(id)) return;
    const room = this.rooms.get(id);
    if (room === undefined) return;
    room.bridge = null;
    const phone = room.phone;
    room.phone = null;
    this.rooms.delete(id);
    if (phone !== null) {
      phone.rooms.delete(id);
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
    for (const id of connection.rooms) {
      const room = this.rooms.get(id);
      if (room === undefined) continue;
      if (room.bridge === connection) {
        room.bridge = null;
        const phone = room.phone;
        room.phone = null;
        if (phone !== null) {
          phone.rooms.delete(id);
          this.dismiss(phone);
        }
      }
      if (room.phone === connection) {
        room.phone = null;
        if (room.bridge !== null) this.toBridge(room.bridge, { type: "peer_left", room: id });
      }
      if (room.bridge === null && room.phone === null) this.rooms.delete(id);
    }
    connection.rooms.clear();
  }

  private drop(connection: Connection, code: number, reason: string): void {
    this.detach(connection);
    connection.socket.close(code, reason);
  }

  private closed(connection: Connection): void {
    this.detach(connection);
    if (!this.connections.delete(connection)) return;
    const count = (this.perAddress.get(connection.address) ?? 1) - 1;
    if (count > 0) this.perAddress.set(connection.address, count);
    else this.perAddress.delete(connection.address);
  }

  private send(connection: Connection, text: string): void {
    if (connection.socket.readyState === connection.socket.OPEN) connection.socket.send(text);
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
      if (!this.perAddress.has(address) && bucket.isFull(now)) this.connectBuckets.delete(address);
    }
  }
}
