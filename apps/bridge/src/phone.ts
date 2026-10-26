import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import {
  ProtocolError,
  SealedChannel,
  bridgeProof,
  commitBridgeProof,
  decodeBytes,
  decodeFrame,
  derivePairingSecrets,
  deriveResumeSecrets,
  encodeFrame,
  generateEphemeralKeyPair,
  heartbeatIntervalMs,
  identityBytes,
  isPairingCode,
  maxPairingAttempts,
  nonceBytes,
  openingBytes,
  pairingCodeTtlMs,
  pairingSecretBytes,
  parsePhoneMessage,
  parseSessionOpenResult,
  parseToolOutcome,
  phoneProof,
  proofBytes,
  protocolVersion,
  publicKeyBytes,
  resumeBridgeProof,
  resumePhoneProof,
  revocationProof,
  sameBytes,
  sharedSecret,
  toBase64,
} from "@obnixe/core/agent/wire";
import type { BridgeMessage, EphemeralKeyPair, Frame, PairingSecrets, PairingTranscript, RandomBytes, RejectionReason, SessionKeys, ToolOutcome } from "@obnixe/core/agent/wire";
import type { PairingFile } from "./pairings.ts";
import { DirectPeer } from "./peer.ts";
import type { PeerSocket } from "./peer.ts";
import { RelayLink } from "./relay.ts";
import type { RelayInvite } from "./relay.ts";

const maxPending = 8;
const maxPendingPerAddress = 2;
const defaultHandshakeTimeoutMs = 10_000;
const defaultProofTimeoutMs = 10_000;
const policyViolation = 1008;
const tryAgainLater = 1013;

export interface EndpointOptions {
  readonly port: number;
  readonly listenHost?: string;
  readonly hostLabel: string;
  readonly pairings: PairingFile;
  readonly randomBytes: RandomBytes;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  readonly callTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly proofTimeoutMs?: number;
}

interface Hello {
  readonly transcript: PairingTranscript;
  readonly shared: Uint8Array;
  readonly receivedAt: number;
}

interface Attempt {
  readonly settle: (proof: Uint8Array | null) => void;
}

interface Pending {
  readonly socket: PeerSocket;
  readonly origin: string;
  readonly bridgeNonce: Uint8Array;
  readonly keyPair: EphemeralKeyPair;
  readonly handshakeTimer: ReturnType<typeof setTimeout>;
  hello: Hello | null;
  attempt: Attempt | null;
  attempts: number;
}

type Candidate = Pending & { readonly hello: Hello };

type Verdict =
  | { readonly kind: "match"; readonly candidate: Candidate; readonly secrets: PairingSecrets; readonly opening: Uint8Array }
  | { readonly kind: "mismatch"; readonly candidate: Candidate }
  | { readonly kind: "gone" };

type Reply = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly message: string };

interface Waiter {
  readonly resolve: (reply: Reply) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Active {
  readonly socket: PeerSocket;
  readonly channel: SealedChannel;
  readonly device: string;
  readonly pairingId: string;
  readonly waiters: Map<number, Waiter>;
  nextId: number;
  open: boolean;
}

export type PairResult =
  | { readonly kind: "paired"; readonly device: string; readonly client: string }
  | { readonly kind: "no_phone" }
  | { readonly kind: "bad_code"; readonly remaining: number }
  | { readonly kind: "invalid_code" }
  | { readonly kind: "failed"; readonly message: string };

interface Establishing {
  readonly socket: PeerSocket;
  readonly device: string;
  readonly pairingId: string;
  readonly keys: SessionKeys;
}

export interface ForgetResult {
  readonly devices: readonly string[];
}

export interface EndpointStatus {
  readonly phone: "none" | "waiting" | "connected";
  readonly device: string | null;
  readonly client: string;
}

export const notConnectedMessage =
  "The Obnixe phone is not connected. Ask the user to open the Agent screen of the Obnixe app (Aujourd'hui, Connecter un agent): a phone paired before reconnects by itself, otherwise run `obnixe-bridge pair` in a terminal with the code shown on the phone, then retry.";

/**
 * Endpoint the phone reaches, by dialing the direct WebSocket listener or through the relay: verifies pairing proofs, then
 * relays sealed JSON-RPC tool calls to the phone.
 */
export class PhoneEndpoint {
  private readonly options: EndpointOptions;
  private readonly now: () => number;
  private readonly bridgeId: string;
  private readonly pendings = new Map<PeerSocket, Pending>();
  private http: Server | null = null;
  private sockets: WebSocketServer | null = null;
  private relay: RelayLink | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private active: Active | null = null;
  private client = "Agent";
  private unavailable: string | null = null;

  constructor(options: EndpointOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.bridgeId = options.pairings.bridgeId();
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
    this.sockets.on("connection", (socket, request) => this.accept(new DirectPeer(socket, remoteAddress(request))));
    this.startHeartbeat();
    return (http.address() as AddressInfo).port;
  }

  /** Also admits phones through the relay at `relayUrl`, in the rooms of the stored pairings and of the pending invite. */
  connectRelay(relayUrl: string): void {
    if (this.relay !== null) return;
    this.relay = new RelayLink({ relayUrl, pairings: this.options.pairings, randomBytes: this.options.randomBytes, onPeer: (peer) => this.accept(peer), log: this.options.log });
    this.relay.start();
    this.startHeartbeat();
  }

  /** Opens a one-time relay room for a first pairing, replacing any pending one; null when no relay is configured. */
  openInviteRoom(): RelayInvite | null {
    return this.relay?.openInvite() ?? null;
  }

  /** Closes the pending invite room once it served its pairing or expired; a phone already connected through it stays. */
  closeInviteRoom(): void {
    this.relay?.closeInvite();
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
    const candidates = [...this.pendings.values()].filter((pending): pending is Candidate => pending.hello !== null && pending.attempt === null);
    if (candidates.length === 0) return { kind: "no_phone" };
    const verdicts = await Promise.all(candidates.map((candidate) => this.attempt(candidate, code)));
    for (const verdict of verdicts) {
      if (verdict.kind === "match" && this.pendings.get(verdict.candidate.socket) === verdict.candidate) return this.welcome(verdict);
    }
    let counted = false;
    let remaining = 0;
    for (const verdict of verdicts) {
      if (verdict.kind !== "mismatch" || this.pendings.get(verdict.candidate.socket) !== verdict.candidate) continue;
      counted = true;
      verdict.candidate.attempts += 1;
      if (verdict.candidate.attempts >= maxPairingAttempts) this.reject(verdict.candidate, "code");
      else remaining = Math.max(remaining, maxPairingAttempts - verdict.candidate.attempts);
    }
    return counted ? { kind: "bad_code", remaining } : { kind: "no_phone" };
  }

  /** Revokes every trusted phone and ends a session that relied on one of them. */
  forgetAll(): ForgetResult {
    const forgotten = this.options.pairings.revokeAll();
    for (const pairing of forgotten) this.endTrusted(pairing.pairingId, "pairing forgotten");
    this.relay?.sync();
    return { devices: forgotten.map((pairing) => pairing.device) };
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
    for (const pending of [...this.pendings.values()]) {
      this.forget(pending);
      pending.socket.terminate();
    }
    if (this.active !== null) this.drop(this.active, "bridge stopped");
    this.relay?.close();
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

  private startHeartbeat(): void {
    this.heartbeat ??= setInterval(() => this.tick(), heartbeatIntervalMs);
  }

  /**
   * Admits a phone. An origin only ever replaces its own oldest pending handshake, and once every slot is taken new
   * sockets are turned away, so a flood from other addresses or rooms cannot evict a phone waiting for its code.
   */
  private accept(socket: PeerSocket): void {
    const origin = socket.origin;
    const sameOrigin = [...this.pendings.values()].filter((pending) => pending.origin === origin);
    const oldest = sameOrigin[0];
    if (sameOrigin.length >= maxPendingPerAddress && oldest !== undefined) this.reject(oldest, "replaced");
    else if (this.pendings.size >= maxPending) {
      this.options.log(`Refused a connection from ${origin}: too many phones are already waiting to pair.`);
      socket.close(tryAgainLater, "busy");
      return;
    }
    const handshakeTimer = setTimeout(() => {
      const pending = this.pendings.get(socket);
      if (pending === undefined || pending.hello !== null) return;
      this.forget(pending);
      socket.terminate();
    }, this.options.handshakeTimeoutMs ?? defaultHandshakeTimeoutMs);
    const pending: Pending = {
      socket,
      origin,
      bridgeNonce: this.options.randomBytes(nonceBytes),
      keyPair: generateEphemeralKeyPair(this.options.randomBytes),
      handshakeTimer,
      hello: null,
      attempt: null,
      attempts: 0,
    };
    this.pendings.set(socket, pending);
    socket.onmessage = (text) => this.receive(socket, text);
    socket.onclose = () => this.closed(socket);
    this.send(socket, { type: "challenge", version: protocolVersion, bridge: this.bridgeId, nonce: toBase64(pending.bridgeNonce), key: toBase64(pending.keyPair.publicKey) });
  }

  private receive(socket: PeerSocket, text: string): void {
    try {
      const frame = decodeFrame(text);
      if (this.active?.socket === socket) this.receiveSealed(this.active, frame);
      else this.receiveHandshake(socket, frame);
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.options.log(`Refused a message: ${error.message}`);
        socket.close(policyViolation, "protocol");
        return;
      }
      throw error;
    }
  }

  private receiveHandshake(socket: PeerSocket, frame: Frame): void {
    const pending = this.pendings.get(socket);
    if (pending === undefined) throw new ProtocolError("Unknown socket");
    switch (frame.type) {
      case "hello":
        this.receiveHello(pending, frame);
        return;
      case "resume":
        this.receiveResume(pending, frame);
        return;
      case "revoke":
        this.receiveRevoke(pending, frame);
        return;
      case "proof": {
        const attempt = pending.attempt;
        if (attempt === null) throw new ProtocolError("Unexpected proof");
        attempt.settle(decodeBytes(frame.proof, proofBytes));
        return;
      }
      case "challenge":
      case "commit":
      case "welcome":
      case "resumed":
      case "rejected":
      case "sealed":
        throw new ProtocolError(`Unexpected ${frame.type} before pairing`);
      default: {
        const unreachable: never = frame;
        throw new ProtocolError(`Unhandled frame ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private receiveHello(pending: Pending, frame: Extract<Frame, { type: "hello" }>): void {
    if (pending.hello !== null) throw new ProtocolError("Unexpected second hello");
    if (frame.version !== protocolVersion) {
      this.reject(pending, "version");
      return;
    }
    const transcript = this.transcriptOf(pending, frame);
    const shared = sharedSecret(pending.keyPair.secretKey, transcript.phoneKey);
    clearTimeout(pending.handshakeTimer);
    pending.hello = { transcript, shared, receivedAt: this.now() };
    this.options.log(`${frame.device} is waiting to pair. Run \`obnixe-bridge pair\` and enter the code shown on the phone.`);
  }

  private transcriptOf(pending: Pending, frame: Extract<Frame, { type: "hello" | "resume" }>): PairingTranscript {
    return {
      bridgeId: decodeBytes(this.bridgeId, identityBytes),
      bridgeNonce: pending.bridgeNonce,
      bridgeKey: pending.keyPair.publicKey,
      deviceId: decodeBytes(frame.deviceId, identityBytes),
      phoneNonce: decodeBytes(frame.nonce, nonceBytes),
      phoneKey: decodeBytes(frame.key, publicKeyBytes),
      device: frame.device,
    };
  }

  /** Verifies the proof of a trusted phone in one round trip; the bridge proof only leaves once the phone proof matched. */
  private receiveResume(pending: Pending, frame: Extract<Frame, { type: "resume" }>): void {
    if (pending.hello !== null) throw new ProtocolError("Unexpected resume after hello");
    if (frame.version !== protocolVersion) {
      this.reject(pending, "version");
      return;
    }
    const lookup = this.options.pairings.lookup(frame.pairing);
    switch (lookup.kind) {
      case "unknown":
        this.options.log(`${frame.device} tried to reconnect with a pairing this Mac does not know; it will show a new code.`);
        this.reject(pending, "unknown");
        return;
      case "revoked":
        this.options.log(`${frame.device} tried to reconnect with a forgotten pairing; it will show a new code.`);
        this.reject(pending, "revoked");
        return;
      case "known":
        break;
      default: {
        const unreachable: never = lookup;
        throw new Error(`Unhandled pairing lookup ${JSON.stringify(unreachable)}`);
      }
    }
    const pairing = lookup.pairing;
    const transcript = this.transcriptOf(pending, frame);
    const shared = sharedSecret(pending.keyPair.secretKey, transcript.phoneKey);
    const secrets = deriveResumeSecrets(decodeBytes(pairing.secret, pairingSecretBytes), { ...transcript, pairingId: decodeBytes(frame.pairing, identityBytes) }, shared);
    const sameDevice = sameBytes(transcript.deviceId, decodeBytes(pairing.deviceId, identityBytes));
    if (!sameDevice || !sameBytes(decodeBytes(frame.proof, proofBytes), resumePhoneProof(secrets))) {
      this.options.log(`Refused a reconnection for ${pairing.device}: the proof does not match the stored pairing.`);
      this.reject(pending, "unknown");
      return;
    }
    this.forget(pending);
    this.send(pending.socket, { type: "resumed", proof: toBase64(resumeBridgeProof(secrets)) });
    void this.establish({ socket: pending.socket, device: frame.device, pairingId: pairing.pairingId, keys: secrets.sessionKeys }).then((result) => {
      if (result.kind === "paired") this.options.log(`Reconnected to ${result.device} without a code.`);
    });
  }

  private receiveRevoke(pending: Pending, frame: Extract<Frame, { type: "revoke" }>): void {
    if (pending.hello !== null) throw new ProtocolError("Unexpected revoke after hello");
    const lookup = this.options.pairings.lookup(frame.pairing);
    if (lookup.kind !== "known") return;
    const expected = revocationProof(decodeBytes(lookup.pairing.secret, pairingSecretBytes), decodeBytes(frame.pairing, identityBytes));
    if (!sameBytes(decodeBytes(frame.proof, proofBytes), expected)) throw new ProtocolError("Invalid revocation proof");
    this.options.pairings.revoke(frame.pairing);
    this.endTrusted(frame.pairing, "pairing revoked by the phone");
    this.relay?.sync();
    this.options.log(`${lookup.pairing.device} forgot this Mac; its pairing is revoked.`);
  }

  private endTrusted(pairingId: string, reason: string): void {
    const active = this.active;
    if (active === null || active.pairingId !== pairingId) return;
    this.drop(active, reason);
    active.socket.close(1000, "forgotten");
  }

  /** Commits to the bridge proof for `code`, then waits for the phone proof; the bridge proof is only revealed on a match. */
  private async attempt(candidate: Candidate, code: string): Promise<Verdict> {
    const secrets = await derivePairingSecrets(code, candidate.hello.transcript, candidate.hello.shared);
    if (this.pendings.get(candidate.socket) !== candidate || candidate.attempt !== null) return { kind: "gone" };
    const opening = this.options.randomBytes(openingBytes);
    const commitment = commitBridgeProof(opening, bridgeProof(secrets));
    const proof = await new Promise<Uint8Array | null>((resolve) => {
      const timer = setTimeout(() => settle(null), this.options.proofTimeoutMs ?? defaultProofTimeoutMs);
      const settle = (value: Uint8Array | null): void => {
        clearTimeout(timer);
        candidate.attempt = null;
        resolve(value);
      };
      candidate.attempt = { settle };
      this.send(candidate.socket, { type: "commit", commitment: toBase64(commitment) });
    });
    if (this.pendings.get(candidate.socket) !== candidate) return { kind: "gone" };
    if (proof === null || !sameBytes(proof, phoneProof(secrets, commitment))) return { kind: "mismatch", candidate };
    return { kind: "match", candidate, secrets, opening };
  }

  private receiveSealed(active: Active, frame: Frame): void {
    if (frame.type !== "sealed") throw new ProtocolError(`Unexpected ${frame.type} in session`);
    const message = parsePhoneMessage(active.channel.open(frame));
    if ("method" in message) {
      this.options.log(`The phone ended the connection (${message.params.reason}).`);
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

  private async welcome(match: Extract<Verdict, { kind: "match" }>): Promise<PairResult> {
    const { candidate, secrets, opening } = match;
    const { socket, hello } = candidate;
    this.forget(candidate);
    const pairingId = toBase64(secrets.pairingId);
    const device = hello.transcript.device;
    this.options.pairings.remember({ pairingId, deviceId: toBase64(hello.transcript.deviceId), device, secret: toBase64(secrets.pairingSecret), pairedAt: this.now() });
    this.relay?.sync();
    this.send(socket, { type: "welcome", opening: toBase64(opening), proof: toBase64(bridgeProof(secrets)) });
    const result = await this.establish({ socket, device, pairingId, keys: secrets.sessionKeys });
    if (result.kind === "paired") this.options.log(`Connected to ${device}. It will reconnect without a code next time.`);
    return result;
  }

  private async establish(establishing: Establishing): Promise<PairResult> {
    const { socket, keys } = establishing;
    const previous = this.active;
    if (previous !== null) {
      this.drop(previous, "replaced by a new session");
      previous.socket.close(1000, "replaced");
    }
    const active: Active = {
      socket,
      channel: new SealedChannel(keys.toPhone, keys.toBridge),
      device: establishing.device,
      pairingId: establishing.pairingId,
      waiters: new Map(),
      nextId: 1,
      open: false,
    };
    this.active = active;
    const reply = await this.request(active, { method: "session.open", params: { client: this.client, host: this.options.hostLabel } });
    if (!reply.ok) {
      this.drop(active, "session refused");
      socket.close(1000, "refused");
      return { kind: "failed", message: reply.message };
    }
    try {
      parseSessionOpenResult(reply.result);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      this.drop(active, "invalid session.open answer");
      socket.close(policyViolation, "protocol");
      return { kind: "failed", message: error.message };
    }
    active.open = true;
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

  private send(socket: PeerSocket, frame: Frame): void {
    socket.send(encodeFrame(frame));
  }

  private reject(pending: Pending, reason: RejectionReason): void {
    this.send(pending.socket, { type: "rejected", reason });
    this.forget(pending);
    pending.socket.close(1000, reason);
  }

  private forget(pending: Pending): void {
    clearTimeout(pending.handshakeTimer);
    if (this.pendings.get(pending.socket) === pending) this.pendings.delete(pending.socket);
    pending.attempt?.settle(null);
  }

  private closed(socket: PeerSocket): void {
    const pending = this.pendings.get(socket);
    if (pending !== undefined) this.forget(pending);
    if (this.active?.socket === socket) {
      if (this.active.open) this.options.log("Phone disconnected.");
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
      if (pending.hello !== null && this.now() - pending.hello.receivedAt > pairingCodeTtlMs) this.reject(pending, "expired");
    }
  }

  private tick(): void {
    this.expirePending();
    const active = this.active;
    if (active === null) return;
    if (!active.socket.heartbeat()) {
      this.options.log("The phone stopped answering; connection closed.");
      active.socket.terminate();
      return;
    }
    if (active.open) this.notify(active, { jsonrpc: "2.0", method: "ping" });
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function remoteAddress(request: IncomingMessage): string {
  const address = request.socket.remoteAddress ?? "unknown";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}
