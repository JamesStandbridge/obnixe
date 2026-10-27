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
  formatInvite,
  generateEphemeralKeyPair,
  heartbeatIntervalMs,
  identityBytes,
  inviteTtlMs,
  isPairingCode,
  maxFrameBytes,
  maxPairingAttempts,
  nonceBytes,
  openingBytes,
  pairingCodeTtlMs,
  pairingSecretBytes,
  pairingTokenBytes,
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
  toBase64Url,
  truncateName,
} from "@obnixe/core/agent/wire";
import type {
  BridgeMessage,
  EphemeralKeyPair,
  Frame,
  PairingSecret,
  PairingSecretKind,
  PairingSecrets,
  PairingTranscript,
  RandomBytes,
  RejectionReason,
  SessionKeys,
  ToolOutcome,
} from "@obnixe/core/agent/wire";
import type { PhoneHosts } from "./listen.ts";
import type { PairingFile } from "./pairings.ts";
import { DirectPeer } from "./peer.ts";
import type { PeerSocket } from "./peer.ts";
import { RelayLink } from "./relay.ts";
import type { RelayInvite } from "./relay.ts";

const maxPending = 8;
const maxPendingPerOrigin = 2;
const maxRelayedPending = 4;
const maxCodeWaiting = 2;
const wildcards: readonly string[] = ["0.0.0.0", "::"];
const defaultHandshakeTimeoutMs = 10_000;
const defaultProofTimeoutMs = 10_000;
const policyViolation = 1008;
const tryAgainLater = 1013;
const inviteIdBytes = 9;

export interface EndpointOptions {
  readonly port: number;
  readonly hosts: () => PhoneHosts;
  readonly hostLabel: string;
  readonly pairings: PairingFile;
  /** Receives failures of the background address rescan, which has no caller to throw to. */
  readonly onError: (error: unknown) => void;
  readonly randomBytes: RandomBytes;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  readonly callTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly proofTimeoutMs?: number;
}

interface Hello {
  readonly secret: PairingSecretKind;
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

function isCandidate(pending: Pending): pending is Candidate {
  return pending.hello !== null;
}

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

export type InviteState =
  | { readonly kind: "waiting"; readonly expiresAt: number }
  | { readonly kind: "paired"; readonly device: string; readonly client: string }
  | { readonly kind: "expired" }
  | { readonly kind: "failed"; readonly message: string };

export interface InviteStatus {
  readonly id: string;
  readonly state: InviteState;
}

export interface InviteTicket {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly hosts: readonly string[];
  readonly expiresAt: number;
}

export type InviteResult = { readonly kind: "ready"; readonly ticket: InviteTicket } | { readonly kind: "no_address" };

/** The QR invitation: a bridge-generated token that stands in for the code, live until used or expired. */
interface Invitation {
  readonly ticket: InviteTicket;
  readonly token: Uint8Array;
  readonly relay: RelayInvite | null;
  consumed: boolean;
  state: InviteState;
}

export interface EndpointStatus {
  readonly phone: "none" | "waiting" | "connected";
  readonly device: string | null;
  readonly client: string;
}

export const notConnectedMessage =
  "The Obnixe phone is not connected. Ask the user to open the Agent screen of the Obnixe app (Aujourd'hui, Connecter un agent): a phone paired before reconnects by itself, otherwise ask them to run `obnixe-bridge pair` in a terminal and scan the QR code it shows with Scanner le QR code, then retry.";

/**
 * Endpoint the phone reaches, by dialing the direct WebSocket listeners or through the relay: verifies pairing proofs, then
 * relays sealed JSON-RPC tool calls to the phone.
 */
export class PhoneEndpoint {
  private readonly options: EndpointOptions;
  private readonly now: () => number;
  private readonly bridgeId: string;
  private readonly pendings = new Map<PeerSocket, Pending>();
  private readonly listeners = new Map<string, Server>();
  private port = 0;
  private announced: readonly string[] = [];
  private invitation: Invitation | null = null;
  private sockets: WebSocketServer | null = null;
  private relay: RelayLink | null = null;
  private refreshing: Promise<void> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private active: Active | null = null;
  private client = "Agent";
  private unavailable: string | null = null;

  constructor(options: EndpointOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.bridgeId = options.pairings.bridgeId();
  }

  /** Binds every phone address on one port; the first address picks the port and fails loudly, later ones only log. */
  async listen(): Promise<number> {
    const sockets = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes });
    sockets.on("connection", (socket, request) => this.accept(new DirectPeer(socket, remoteAddress(request))));
    this.sockets = sockets;
    const hosts = this.options.hosts();
    const [first, ...others] = hosts.bind;
    if (first === undefined) throw new Error("No address to listen on");
    this.port = await this.bind(sockets, first, this.options.port);
    for (const address of others) await this.bindIfAvailable(sockets, address);
    this.announced = this.advertised(hosts);
    this.startHeartbeat();
    return this.port;
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

  private startHeartbeat(): void {
    this.heartbeat ??= setInterval(() => this.tick(), heartbeatIntervalMs);
  }

  /** Follows interface changes such as a new DHCP lease: binds new addresses, drops vanished ones and tells the phone. */
  refreshHosts(): Promise<void> {
    if (this.refreshing !== null) return this.refreshing;
    const refreshing = this.rescan().finally(() => {
      this.refreshing = null;
    });
    this.refreshing = refreshing;
    return refreshing;
  }

  private async rescan(): Promise<void> {
    const sockets = this.sockets;
    if (sockets === null) return;
    const hosts = this.options.hosts();
    for (const [address, http] of [...this.listeners]) {
      if (hosts.bind.includes(address)) continue;
      this.listeners.delete(address);
      http.close();
    }
    for (const address of hosts.bind) {
      if (this.sockets !== sockets) return;
      if (!this.listeners.has(address)) await this.bindIfAvailable(sockets, address);
    }
    if (this.sockets !== sockets) return;
    const advertised = this.advertised(hosts);
    if (advertised.join(",") === this.announced.join(",")) return;
    this.announced = advertised;
    const active = this.active;
    if (active?.open === true) this.notify(active, { jsonrpc: "2.0", method: "session.hosts", params: { hosts: [...advertised] } });
  }

  /** Announces only the addresses a listener actually holds, every one of them behind a wildcard bind. */
  private advertised(hosts: PhoneHosts): readonly string[] {
    const wildcard = [...this.listeners.keys()].some((address) => wildcards.includes(address));
    return hosts.advertise.filter((address) => wildcard || this.listeners.has(address)).map((address) => `${address}:${this.port}`);
  }

  private async bind(sockets: WebSocketServer, address: string, port: number): Promise<number> {
    const http = createServer((_request, response) => {
      response.writeHead(426, { "content-type": "text/plain" }).end("Obnixe bridge expects a WebSocket");
    });
    http.on("upgrade", (request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, (upgraded) => sockets.emit("connection", upgraded, request));
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, address, () => {
        http.off("error", reject);
        resolve();
      });
    });
    if (this.sockets !== sockets) {
      http.close();
      return (http.address() as AddressInfo).port;
    }
    this.listeners.set(address, http);
    return (http.address() as AddressInfo).port;
  }

  private async bindIfAvailable(sockets: WebSocketServer, address: string): Promise<void> {
    try {
      await this.bind(sockets, address, this.port);
    } catch (error) {
      if (!isUnavailableAddress(error)) throw error;
      this.options.log(`Could not listen on ${address}:${this.port} (${error.code}); the phone cannot use that address.`);
    }
  }

  markUnavailable(reason: string): void {
    this.unavailable = reason;
  }

  setClient(client: string): void {
    this.client = client;
    const active = this.active;
    if (active?.open === true) this.notify(active, { jsonrpc: "2.0", method: "session.client", params: { client } });
  }

  /** The live invitation when `fresh` is false and one is live, otherwise a new single-use token valid for five minutes. */
  invite(fresh: boolean): InviteResult {
    const live = this.liveInvitation();
    if (!fresh && live !== null) return { kind: "ready", ticket: live.ticket };
    if (this.announced.length === 0 && this.relay === null) return { kind: "no_address" };
    const token = this.options.randomBytes(pairingTokenBytes);
    const name = truncateName(this.options.hostLabel);
    const relay = this.openInviteRoom();
    const expiresAt = Math.floor((this.now() + inviteTtlMs) / 1000) * 1000;
    const url = formatInvite({ bridgeId: this.bridgeId, token, name, hosts: this.announced, expiresAt, relay: relay === null ? null : { url: relay.relayUrl, room: relay.room } });
    const ticket: InviteTicket = { id: toBase64Url(this.options.randomBytes(inviteIdBytes)), url, name, hosts: this.announced, expiresAt };
    this.invitation = { ticket, token, relay, consumed: false, state: { kind: "waiting", expiresAt } };
    this.options.log("A pairing QR code is ready for five minutes.");
    return { kind: "ready", ticket };
  }

  inviteStatus(): InviteStatus | null {
    this.liveInvitation();
    const invitation = this.invitation;
    return invitation === null ? null : { id: invitation.ticket.id, state: invitation.state };
  }

  private liveInvitation(): Invitation | null {
    const invitation = this.invitation;
    if (invitation === null || invitation.consumed || invitation.state.kind !== "waiting") return null;
    if (this.now() < invitation.ticket.expiresAt) return invitation;
    invitation.state = { kind: "expired" };
    if (invitation.relay !== null) this.closeInviteRoom();
    return null;
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
    const candidates = [...this.pendings.values()].filter((pending): pending is Candidate => pending.hello?.secret === "code" && pending.attempt === null);
    if (candidates.length === 0) return { kind: "no_phone" };
    const verdicts = await Promise.all(candidates.map((candidate) => this.attempt(candidate, { kind: "code", code })));
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
    this.relay = null;
    const sockets = this.sockets;
    this.sockets = null;
    if (sockets !== null) {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    }
    const listeners = [...this.listeners.values()];
    this.listeners.clear();
    await Promise.all(
      listeners.map((http) => {
        http.closeAllConnections();
        return new Promise<void>((resolve) => http.close(() => resolve()));
      }),
    );
  }

  /**
   * Admits a dialing phone. Phones waiting for a code typed on the Mac live in their own small pool, so they never take a
   * handshake slot from a resume or a QR pairing. A remote address only ever replaces its own oldest handshake, and once
   * every slot is taken new sockets are turned away, so a flood from other addresses or rooms cannot evict a handshake in
   * progress. Relayed peers never get more than `maxRelayedPending` slots, so some always remain for the direct listeners.
   */
  private accept(socket: PeerSocket): void {
    const origin = socket.origin;
    const handshaking = [...this.pendings.values()].filter((pending) => pending.hello?.secret !== "code");
    const sameOrigin = handshaking.filter((pending) => pending.origin === origin);
    const oldest = sameOrigin[0];
    const relayed = handshaking.filter((pending) => pending.socket.transport === "relay").length;
    if (sameOrigin.length >= maxPendingPerOrigin && oldest !== undefined) this.reject(oldest, "replaced");
    else if (handshaking.length >= maxPending || (socket.transport === "relay" && relayed >= maxRelayedPending)) {
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

  /**
   * Through the relay only a QR token pairs, and only in the room of the live invitation: the relay operator could crack a
   * 6-digit code offline from the phone proof, never a 256-bit token. Relayed peers otherwise may only resume a pairing.
   */
  private relayedHelloAllowed(pending: Pending, frame: Extract<Frame, { type: "hello" }>): boolean {
    if (pending.socket.transport === "direct") return true;
    const invitation = this.liveInvitation();
    return frame.secret === "token" && invitation?.relay !== null && invitation?.relay.room === pending.socket.room;
  }

  private receiveHello(pending: Pending, frame: Extract<Frame, { type: "hello" }>): void {
    if (pending.hello !== null) throw new ProtocolError("Unexpected second hello");
    if (!this.relayedHelloAllowed(pending, frame)) {
      this.options.log(`Refused to pair ${frame.device} through the relay: scan a fresh QR code, or pair once on the same network.`);
      this.forget(pending);
      pending.socket.close(policyViolation, "pairing through the relay needs the live QR code");
      return;
    }
    if (frame.version !== protocolVersion) {
      this.reject(pending, "version");
      return;
    }
    const transcript = this.transcriptOf(pending, frame);
    const shared = sharedSecret(pending.keyPair.secretKey, transcript.phoneKey);
    clearTimeout(pending.handshakeTimer);
    pending.hello = { secret: frame.secret, transcript, shared, receivedAt: this.now() };
    switch (frame.secret) {
      case "code":
        this.limitCodeWaiting();
        this.options.log(`${frame.device} is waiting to pair. Run \`obnixe-bridge pair <code>\` with the code shown on the phone.`);
        return;
      case "token":
        if (isCandidate(pending)) void this.pairWithToken(pending);
        return;
      default: {
        const unreachable: never = frame.secret;
        throw new ProtocolError(`Unhandled pairing secret ${String(unreachable)}`);
      }
    }
  }

  /** Keeps at most `maxCodeWaiting` phones waiting for a typed code, dropping the oldest. */
  private limitCodeWaiting(): void {
    const waiting = [...this.pendings.values()]
      .filter((pending): pending is Candidate => pending.hello?.secret === "code")
      .sort((left, right) => left.hello.receivedAt - right.hello.receivedAt);
    for (const pending of waiting.slice(0, Math.max(0, waiting.length - maxCodeWaiting))) this.reject(pending, "replaced");
  }

  /** Pairs a phone that scanned the QR code; the token is spent by the first matching proof, a wrong proof only ends its own attempt. */
  private async pairWithToken(candidate: Candidate): Promise<void> {
    const device = candidate.hello.transcript.device;
    const invitation = this.liveInvitation();
    if (invitation === null) {
      this.options.log(`${device} scanned a QR code that is no longer valid; run \`obnixe-bridge pair\` for a new one.`);
      this.reject(candidate, "expired");
      return;
    }
    const verdict = await this.attempt(candidate, { kind: "token", token: invitation.token });
    switch (verdict.kind) {
      case "gone":
        return;
      case "mismatch":
        this.options.log(`Refused a QR pairing from ${candidate.origin}: its proof does not match the QR code.`);
        this.reject(candidate, "code");
        return;
      case "match": {
        if (this.liveInvitation() !== invitation) {
          this.reject(candidate, "expired");
          return;
        }
        invitation.consumed = true;
        if (invitation.relay !== null) this.closeInviteRoom();
        const result = await this.welcome(verdict);
        invitation.state = result.kind === "paired" ? { kind: "paired", device: result.device, client: result.client } : { kind: "failed", message: describeFailure(result) };
        return;
      }
      default: {
        const unreachable: never = verdict;
        throw new Error(`Unhandled verdict ${JSON.stringify(unreachable)}`);
      }
    }
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
        this.options.log(`${frame.device} tried to reconnect with a pairing this computer does not know; it will show a new code.`);
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
    this.options.log(`${lookup.pairing.device} forgot this computer; its pairing is revoked.`);
  }

  private endTrusted(pairingId: string, reason: string): void {
    const active = this.active;
    if (active === null || active.pairingId !== pairingId) return;
    this.drop(active, reason);
    active.socket.close(1000, "forgotten");
  }

  /** Commits to the bridge proof for `secret`, then waits for the phone proof; the bridge proof is only revealed on a match. */
  private async attempt(candidate: Candidate, secret: PairingSecret): Promise<Verdict> {
    const secrets = await derivePairingSecrets(secret, candidate.hello.transcript, candidate.hello.shared);
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
    const reply = await this.request(active, { method: "session.open", params: { client: this.client, host: this.options.hostLabel, hosts: [...this.announced] } });
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
    this.liveInvitation();
    this.refreshHosts().catch(this.options.onError);
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

function isUnavailableAddress(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error && "code" in error && (error.code === "EADDRINUSE" || error.code === "EADDRNOTAVAIL");
}

function describeFailure(result: Exclude<PairResult, { kind: "paired" }>): string {
  switch (result.kind) {
    case "failed":
      return result.message;
    case "no_phone":
      return "The phone left before the session opened";
    case "bad_code":
    case "invalid_code":
      return "The pairing proof did not match";
    default: {
      const unreachable: never = result;
      throw new Error(`Unhandled pair result ${JSON.stringify(unreachable)}`);
    }
  }
}


function remoteAddress(request: IncomingMessage): string {
  const address = request.socket.remoteAddress ?? "unknown";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}
