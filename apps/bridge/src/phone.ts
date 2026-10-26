import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import {
  ProtocolError,
  SealedChannel,
  decodeBytes,
  decodeFrame,
  derivePairingKey,
  deriveSessionKeys,
  encodeFrame,
  heartbeatIntervalMs,
  helloProof,
  isPairingCode,
  maxPairingAttempts,
  nonceBytes,
  pairingCodeTtlMs,
  parsePhoneMessage,
  parseSessionOpenResult,
  parseToolOutcome,
  protocolVersion,
  sameBytes,
  toBase64,
  welcomeProof,
} from "@obnixe/core/agent/wire";
import type { BridgeMessage, Frame, PairingTranscript, RandomBytes, RejectionReason, ToolOutcome } from "@obnixe/core/agent/wire";

const maxPending = 4;
const policyViolation = 1008;

export interface EndpointOptions {
  readonly port: number;
  readonly listenHost?: string;
  readonly hostLabel: string;
  readonly randomBytes: RandomBytes;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  readonly callTimeoutMs?: number;
}

interface Hello {
  readonly transcript: PairingTranscript;
  readonly proof: Uint8Array;
  readonly receivedAt: number;
}

interface Pending {
  readonly socket: WebSocket;
  readonly bridgeNonce: Uint8Array;
  hello: Hello | null;
  attempts: number;
}

type Reply = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly message: string };

interface Waiter {
  readonly resolve: (reply: Reply) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Active {
  readonly socket: WebSocket;
  readonly channel: SealedChannel;
  readonly device: string;
  readonly waiters: Map<number, Waiter>;
  nextId: number;
  open: boolean;
  alive: boolean;
}

export type PairResult =
  | { readonly kind: "paired"; readonly device: string; readonly client: string }
  | { readonly kind: "no_phone" }
  | { readonly kind: "bad_code"; readonly remaining: number }
  | { readonly kind: "invalid_code" }
  | { readonly kind: "failed"; readonly message: string };

export interface EndpointStatus {
  readonly phone: "none" | "waiting" | "connected";
  readonly device: string | null;
  readonly client: string;
}

export const notConnectedMessage =
  "The Obnixe phone is not connected. Ask the user to open the Agent screen of the Obnixe app (Aujourd'hui, Connecter un agent) and to run `obnixe-bridge pair` in a terminal with the code shown on the phone, then retry.";

/** WebSocket endpoint the phone dials: verifies pairing proofs, then relays sealed JSON-RPC tool calls to the phone. */
export class PhoneEndpoint {
  private readonly options: EndpointOptions;
  private readonly now: () => number;
  private readonly pendings = new Map<WebSocket, Pending>();
  private http: Server | null = null;
  private sockets: WebSocketServer | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private active: Active | null = null;
  private client = "Agent";
  private unavailable: string | null = null;

  constructor(options: EndpointOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async listen(): Promise<number> {
    const http = createServer((_request, response) => {
      response.writeHead(426, { "content-type": "text/plain" }).end("Obnixe bridge expects a WebSocket");
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.options.port, this.options.listenHost, () => {
        http.off("error", reject);
        resolve();
      });
    });
    this.http = http;
    this.sockets = new WebSocketServer({ server: http, maxPayload: 4 * 1024 * 1024 });
    this.sockets.on("connection", (socket) => this.accept(socket));
    this.heartbeat = setInterval(() => this.tick(), heartbeatIntervalMs);
    return (http.address() as AddressInfo).port;
  }

  markUnavailable(reason: string): void {
    this.unavailable = reason;
  }

  setClient(client: string): void {
    this.client = client;
    const active = this.active;
    if (active?.open === true) this.notify(active, { jsonrpc: "2.0", method: "session.client", params: { client } });
  }

  status(): EndpointStatus {
    if (this.active?.open === true) return { phone: "connected", device: this.active.device, client: this.client };
    const waiting = [...this.pendings.values()].find((pending) => pending.hello !== null);
    return { phone: waiting === undefined ? "none" : "waiting", device: waiting?.hello?.transcript.device ?? null, client: this.client };
  }

  async pair(input: string): Promise<PairResult> {
    const code = input.replace(/\s+/g, "");
    if (!isPairingCode(code)) return { kind: "invalid_code" };
    this.expirePending();
    const candidates = [...this.pendings.values()].filter((pending): pending is Pending & { hello: Hello } => pending.hello !== null);
    if (candidates.length === 0) return { kind: "no_phone" };
    for (const candidate of candidates) {
      const key = await derivePairingKey(code, candidate.hello.transcript);
      if (this.pendings.get(candidate.socket) !== candidate) continue;
      if (sameBytes(candidate.hello.proof, helloProof(key, candidate.hello.transcript))) return this.establish(candidate, key);
    }
    let remaining = 0;
    for (const candidate of candidates) {
      candidate.attempts += 1;
      if (candidate.attempts >= maxPairingAttempts) this.reject(candidate.socket, "code");
      else remaining = Math.max(remaining, maxPairingAttempts - candidate.attempts);
    }
    return { kind: "bad_code", remaining };
  }

  async callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
    if (this.unavailable !== null) return { text: this.unavailable, isError: true };
    const active = this.active;
    if (active === null || !active.open) return { text: notConnectedMessage, isError: true };
    const reply = await this.request(active, { method: "tools/call", params: { name, arguments: { ...args } } });
    if (!reply.ok) return { text: reply.message, isError: true };
    return parseToolOutcome(reply.result);
  }

  async close(): Promise<void> {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    for (const pending of this.pendings.values()) pending.socket.terminate();
    this.pendings.clear();
    if (this.active !== null) this.drop(this.active, "bridge stopped");
    const sockets = this.sockets;
    const http = this.http;
    if (sockets !== null) {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    }
    if (http !== null) {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }

  private accept(socket: WebSocket): void {
    if (this.pendings.size >= maxPending) {
      const oldest = this.pendings.keys().next().value;
      if (oldest !== undefined) this.reject(oldest, "replaced");
    }
    const pending: Pending = { socket, bridgeNonce: this.options.randomBytes(nonceBytes), hello: null, attempts: 0 };
    this.pendings.set(socket, pending);
    socket.on("message", (data, isBinary) => this.receive(socket, data, isBinary));
    socket.on("close", () => this.closed(socket));
    socket.on("pong", () => {
      if (this.active?.socket === socket) this.active.alive = true;
    });
    this.send(socket, { type: "challenge", version: protocolVersion, nonce: toBase64(pending.bridgeNonce) });
  }

  private receive(socket: WebSocket, data: RawData, isBinary: boolean): void {
    try {
      if (isBinary) throw new ProtocolError("Binary frames are not part of the protocol");
      const frame = decodeFrame(rawText(data));
      if (this.active?.socket === socket) this.receiveSealed(this.active, frame);
      else this.receiveHello(socket, frame);
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.options.log(`Message refusé : ${error.message}`);
        socket.close(policyViolation, "protocol");
        return;
      }
      throw error;
    }
  }

  private receiveHello(socket: WebSocket, frame: Frame): void {
    const pending = this.pendings.get(socket);
    if (pending === undefined) throw new ProtocolError("Unknown socket");
    if (frame.type !== "hello" || pending.hello !== null) throw new ProtocolError(`Unexpected ${frame.type} before pairing`);
    if (frame.version !== protocolVersion) {
      this.reject(socket, "version");
      return;
    }
    pending.hello = {
      transcript: { bridgeNonce: pending.bridgeNonce, phoneNonce: decodeBytes(frame.nonce, nonceBytes), device: frame.device },
      proof: decodeBytes(frame.proof, 32),
      receivedAt: this.now(),
    };
    this.options.log(`${frame.device} attend l'appairage. Lance \`obnixe-bridge pair\` et saisis le code affiché.`);
  }

  private receiveSealed(active: Active, frame: Frame): void {
    if (frame.type !== "sealed") throw new ProtocolError(`Unexpected ${frame.type} in session`);
    const message = parsePhoneMessage(active.channel.open(frame));
    if ("method" in message) {
      this.options.log(`Connexion coupée depuis le téléphone (${message.params.reason}).`);
      this.drop(active, "phone closed the session");
      active.socket.close(1000, "closed");
      return;
    }
    const waiter = active.waiters.get(message.id);
    if (waiter === undefined) return;
    active.waiters.delete(message.id);
    clearTimeout(waiter.timer);
    waiter.resolve("result" in message ? { ok: true, result: message.result } : { ok: false, message: message.error.message });
  }

  private async establish(candidate: Pending & { hello: Hello }, key: Uint8Array): Promise<PairResult> {
    const { socket, hello } = candidate;
    this.pendings.delete(socket);
    if (this.active !== null) {
      this.drop(this.active, "replaced by a new pairing");
      this.active.socket.close(1000, "replaced");
    }
    this.send(socket, { type: "welcome", proof: toBase64(welcomeProof(key, hello.transcript)) });
    const keys = deriveSessionKeys(key, hello.transcript);
    const active: Active = { socket, channel: new SealedChannel(keys.toPhone, keys.toBridge), device: hello.transcript.device, waiters: new Map(), nextId: 1, open: false, alive: true };
    this.active = active;
    const reply = await this.request(active, { method: "session.open", params: { client: this.client, host: this.options.hostLabel } });
    if (!reply.ok) {
      this.drop(active, "session refused");
      socket.close(1000, "refused");
      return { kind: "failed", message: reply.message };
    }
    parseSessionOpenResult(reply.result);
    active.open = true;
    this.options.log(`Connecté à ${active.device}.`);
    return { kind: "paired", device: active.device, client: this.client };
  }

  private request(active: Active, call: DistributiveOmit<Extract<BridgeMessage, { id: number }>, "jsonrpc" | "id">): Promise<Reply> {
    const id = active.nextId;
    active.nextId += 1;
    return new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => {
        active.waiters.delete(id);
        resolve({ ok: false, message: "The phone did not answer in time. It may have locked or left the Agent screen." });
      }, this.options.callTimeoutMs ?? 60_000);
      active.waiters.set(id, { resolve, timer });
      this.notify(active, { jsonrpc: "2.0", id, ...call } as BridgeMessage);
    });
  }

  private notify(active: Active, message: BridgeMessage): void {
    this.send(active.socket, active.channel.seal(message));
  }

  private send(socket: WebSocket, frame: Frame): void {
    if (socket.readyState === socket.OPEN) socket.send(encodeFrame(frame));
  }

  private reject(socket: WebSocket, reason: RejectionReason): void {
    this.send(socket, { type: "rejected", reason });
    this.pendings.delete(socket);
    socket.close(1000, reason);
  }

  private closed(socket: WebSocket): void {
    this.pendings.delete(socket);
    if (this.active?.socket === socket) {
      if (this.active.open) this.options.log("Téléphone déconnecté.");
      this.drop(this.active, "phone disconnected");
    }
  }

  private drop(active: Active, reason: string): void {
    if (this.active === active) this.active = null;
    active.open = false;
    for (const waiter of active.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, message: `${notConnectedMessage} (${reason})` });
    }
    active.waiters.clear();
  }

  private expirePending(): void {
    for (const pending of [...this.pendings.values()]) {
      if (pending.hello !== null && this.now() - pending.hello.receivedAt > pairingCodeTtlMs) this.reject(pending.socket, "expired");
    }
  }

  private tick(): void {
    this.expirePending();
    const active = this.active;
    if (active === null) return;
    if (!active.alive) {
      this.options.log("Téléphone injoignable, connexion coupée.");
      active.socket.terminate();
      return;
    }
    active.alive = false;
    active.socket.ping();
    if (active.open) this.notify(active, { jsonrpc: "2.0", method: "ping" });
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
