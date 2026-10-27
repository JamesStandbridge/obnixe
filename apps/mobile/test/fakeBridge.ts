import { randomFillSync } from "node:crypto";
import {
  SealedChannel,
  bridgeProof,
  commitBridgeProof,
  decodeBytes,
  decodeFrame,
  derivePairingSecrets,
  deriveResumeSecrets,
  encodeFrame,
  generateEphemeralKeyPair,
  parsePhoneMessage,
  phoneProof,
  protocolVersion,
  resumeBridgeProof,
  resumePhoneProof,
  revocationProof,
  sharedSecret,
  toBase64,
} from "@obnixe/core";
import type { BridgeMessage, EphemeralKeyPair, Frame, PairingSecret, PairingSecrets, PairingTranscript, PhoneMessage, RejectionReason } from "@obnixe/core";

export function randomBytes(length: number): Uint8Array {
  return randomFillSync(new Uint8Array(length));
}

function sameText(left: Uint8Array, right: Uint8Array): boolean {
  return toBase64(left) === toBase64(right);
}

/** Stands in for the global WebSocket the phone link dials; frames cross it asynchronously, like a network. */
export class FakeWebSocket {
  static readonly created: FakeWebSocket[] = [];
  static bridge: FakeBridge | null = null;
  /** Bridges answering on a given `host:port`; any other address reaches `bridge`. */
  static readonly bridges = new Map<string, FakeBridge>();
  /** Relays by WebSocket URL, each mapping a room to the bridge that joined it. */
  static readonly relays = new Map<string, Map<string, FakeBridge>>();

  readonly url: string;
  readonly openedAt: number;
  readonly sent: Frame[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private connection: BridgeConnection | null = null;
  private relay: Map<string, FakeBridge> | null = null;

  constructor(url: string) {
    this.url = url;
    this.openedAt = Date.now();
    FakeWebSocket.created.push(this);
    const relay = FakeWebSocket.relays.get(url);
    if (relay !== undefined) {
      this.relay = relay;
      queueMicrotask(() => {
        if (!this.closed) this.onopen?.();
      });
      return;
    }
    const bridge = FakeWebSocket.bridges.get(url.replace(/^ws:\/\//, "")) ?? FakeWebSocket.bridge;
    queueMicrotask(() => {
      if (this.closed) return;
      if (bridge === null || !bridge.online) {
        this.drop();
        return;
      }
      this.onopen?.();
      this.connection = bridge.accept(this);
    });
  }

  static reset(): void {
    FakeWebSocket.created.length = 0;
    FakeWebSocket.bridge = null;
    FakeWebSocket.bridges.clear();
    FakeWebSocket.relays.clear();
  }

  send(text: string): void {
    if (this.closed) return;
    const relay = this.relay;
    if (relay !== null && this.connection === null) {
      this.joinRelay(relay, (JSON.parse(text) as { room: string }).room);
      return;
    }
    const frame = decodeFrame(text);
    this.sent.push(frame);
    const connection = this.connection;
    queueMicrotask(() => {
      if (!this.closed) connection?.receive(frame);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.onclose?.());
  }

  /** Pairs the phone with the bridge of `room`, as the relay does, or leaves it waiting when no bridge joined that room. */
  private joinRelay(relay: Map<string, FakeBridge>, room: string): void {
    const bridge = relay.get(room);
    if (bridge === undefined || !bridge.online) return;
    queueMicrotask(() => {
      if (this.closed) return;
      this.onmessage?.({ data: JSON.stringify({ type: "peer" }) });
      this.connection = bridge.accept(this);
    });
  }

  deliver(frame: Frame): void {
    queueMicrotask(() => {
      if (!this.closed) this.onmessage?.({ data: encodeFrame(frame) });
    });
  }

  /** The network or the bridge ends the socket. */
  drop(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

interface WaitingHello {
  readonly transcript: PairingTranscript;
  readonly shared: Uint8Array;
}

interface Attempt {
  readonly secrets: PairingSecrets;
  readonly commitment: Uint8Array;
  readonly opening: Uint8Array;
}

class BridgeConnection {
  private readonly bridge: FakeBridge;
  readonly socket: FakeWebSocket;
  private readonly nonce = randomBytes(32);
  private readonly keyPair: EphemeralKeyPair = generateEphemeralKeyPair(randomBytes);
  hello: WaitingHello | null = null;
  private attempt: Attempt | null = null;
  private channel: SealedChannel | null = null;
  readonly messages: PhoneMessage[] = [];

  constructor(bridge: FakeBridge, socket: FakeWebSocket) {
    this.bridge = bridge;
    this.socket = socket;
    if (!bridge.silent) socket.deliver({ type: "challenge", version: protocolVersion, bridge: toBase64(bridge.id), nonce: toBase64(this.nonce), key: toBase64(this.keyPair.publicKey) });
  }

  receive(frame: Frame): void {
    switch (frame.type) {
      case "revoke":
        if (!this.bridge.ignoreRevocations) this.bridge.revoke(frame.pairing, decodeBytes(frame.proof));
        return;
      case "hello": {
        this.hello = { transcript: this.transcriptOf(frame), shared: sharedSecret(this.keyPair.secretKey, decodeBytes(frame.key)) };
        const token = this.bridge.token;
        if (frame.secret === "token") {
          if (token === null) this.reject("expired");
          else void this.commitTo({ kind: "token", token });
        }
        return;
      }
      case "resume":
        this.resume(frame);
        return;
      case "proof":
        if (this.bridge.answerProofs) this.answerProof(decodeBytes(frame.proof));
        return;
      case "sealed": {
        if (this.channel === null) throw new Error("Sealed frame before the session");
        this.messages.push(parsePhoneMessage(this.channel.open(frame)));
        return;
      }
      case "challenge":
      case "commit":
      case "welcome":
      case "resumed":
      case "rejected":
        throw new Error(`The phone sent ${frame.type}`);
      default: {
        const unreachable: never = frame;
        throw new Error(`Unhandled frame ${JSON.stringify(unreachable)}`);
      }
    }
  }

  typeCode(code: string): Promise<void> {
    return this.commitTo({ kind: "code", code });
  }

  private async commitTo(secret: PairingSecret): Promise<void> {
    const hello = this.hello;
    if (hello === null) throw new Error("No phone is waiting for a code");
    const secrets = await derivePairingSecrets(secret, hello.transcript, hello.shared);
    const opening = randomBytes(32);
    const commitment = commitBridgeProof(opening, bridgeProof(secrets));
    this.attempt = { secrets, commitment, opening };
    this.socket.deliver({ type: "commit", commitment: toBase64(commitment) });
  }

  reject(reason: RejectionReason): void {
    this.socket.deliver({ type: "rejected", reason });
  }

  ping(): void {
    this.sendSealed({ jsonrpc: "2.0", method: "ping" });
  }

  private transcriptOf(frame: Extract<Frame, { type: "hello" | "resume" }>): PairingTranscript {
    return {
      bridgeId: this.bridge.id,
      bridgeNonce: this.nonce,
      bridgeKey: this.keyPair.publicKey,
      deviceId: decodeBytes(frame.deviceId),
      phoneNonce: decodeBytes(frame.nonce),
      phoneKey: decodeBytes(frame.key),
      device: frame.device,
    };
  }

  private answerProof(proof: Uint8Array): void {
    const attempt = this.attempt;
    if (attempt === null) throw new Error("Proof without a commit");
    this.attempt = null;
    if (!sameText(proof, phoneProof(attempt.secrets, attempt.commitment))) {
      this.reject("code");
      return;
    }
    this.bridge.trust(toBase64(attempt.secrets.pairingId), attempt.secrets.pairingSecret);
    this.socket.deliver({ type: "welcome", opening: toBase64(attempt.opening), proof: toBase64(bridgeProof(attempt.secrets)) });
    this.open(new SealedChannel(attempt.secrets.sessionKeys.toPhone, attempt.secrets.sessionKeys.toBridge));
  }

  private resume(frame: Extract<Frame, { type: "resume" }>): void {
    const refusal = this.bridge.resumeRefusal(frame.pairing);
    if (refusal !== null) {
      this.reject(refusal);
      return;
    }
    const secret = this.bridge.secretOf(frame.pairing);
    if (secret === null) throw new Error("Resume refusal missed an unknown pairing");
    const transcript = this.transcriptOf(frame);
    const secrets = deriveResumeSecrets(secret, { ...transcript, pairingId: decodeBytes(frame.pairing) }, sharedSecret(this.keyPair.secretKey, transcript.phoneKey));
    if (!sameText(decodeBytes(frame.proof), resumePhoneProof(secrets))) {
      this.reject("unknown");
      return;
    }
    this.socket.deliver({ type: "resumed", proof: toBase64(resumeBridgeProof(secrets)) });
    this.open(new SealedChannel(secrets.sessionKeys.toPhone, secrets.sessionKeys.toBridge));
  }

  private open(channel: SealedChannel): void {
    this.channel = channel;
    this.sendSealed({ jsonrpc: "2.0", id: 1, method: "session.open", params: { client: "Cursor", host: this.bridge.name, hosts: [...this.bridge.hosts] } });
  }

  private sendSealed(message: BridgeMessage): void {
    const channel = this.channel;
    if (channel === null) throw new Error("No session to send on");
    this.socket.deliver(channel.seal(message));
  }
}

/** Bridge side of the phone protocol, written against the core primitives the real bridge uses. */
export class FakeBridge {
  readonly id = randomBytes(16);
  name = "MacBook Pro";
  token: Uint8Array | null = null;
  silent = false;
  hosts: readonly string[] = [];
  readonly connections: BridgeConnection[] = [];
  readonly revoked: string[] = [];
  online = true;
  answerProofs = true;
  ignoreRevocations = false;
  forcedRefusal: RejectionReason | null = null;
  private readonly pairings = new Map<string, Uint8Array>();

  accept(socket: FakeWebSocket): BridgeConnection {
    const connection = new BridgeConnection(this, socket);
    this.connections.push(connection);
    return connection;
  }

  get latest(): BridgeConnection {
    const connection = this.connections.at(-1);
    if (connection === undefined) throw new Error("No phone connected");
    return connection;
  }

  get knownPairings(): readonly string[] {
    return [...this.pairings.keys()];
  }

  trust(pairingId: string, secret: Uint8Array): void {
    this.pairings.set(pairingId, secret);
  }

  forgetAll(): void {
    this.pairings.clear();
  }

  secretOf(pairingId: string): Uint8Array | null {
    return this.pairings.get(pairingId) ?? null;
  }

  resumeRefusal(pairingId: string): RejectionReason | null {
    if (this.forcedRefusal !== null) return this.forcedRefusal;
    if (this.revoked.includes(pairingId)) return "revoked";
    return this.pairings.has(pairingId) ? null : "unknown";
  }

  revoke(pairingId: string, proof: Uint8Array): void {
    const secret = this.pairings.get(pairingId);
    if (secret === undefined) return;
    if (!sameText(proof, revocationProof(secret, decodeBytes(pairingId)))) throw new Error("Invalid revocation proof");
    this.pairings.delete(pairingId);
    this.revoked.push(pairingId);
  }
}
