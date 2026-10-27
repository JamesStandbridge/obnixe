import { z } from "zod";
import type { ConnectionEndReason, Id } from "@obnixe/schema";
import { sameBytes } from "../bytes.ts";
import type { ConnectionPeer } from "./connection.ts";
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
  heartbeatTimeoutMs,
  identityBytes,
  nonceBytes,
  openingBytes,
  pairingSecretBytes,
  parseBridgeMessage,
  phoneProof,
  proofBytes,
  protocolVersion,
  publicKeyBytes,
  resumeBridgeProof,
  resumePhoneProof,
  revocationProof,
  rpcErrorCodes,
  sharedSecret,
} from "./protocol.ts";
import type { BridgeMessage, Frame, HandshakeSecrets, PairingSecrets, PairingTranscript, PhoneMessage, RandomBytes, RejectionReason, ToolOutcome } from "./protocol.ts";
import { toBase64 } from "./encoding.ts";
import { phoneHostsSchema } from "./hosts.ts";

/** A bridge other than the trusted one answered on a remembered address; the caller should try another address. */
export class ForeignBridgeError extends ProtocolError {}

export type PhoneLinkStatus = "proving" | "waiting" | "resuming" | "open" | "closed";

export interface PhoneSocket {
  readonly send: (text: string) => void;
  readonly close: () => void;
}

const phonePairingSchema = z.object({
  pairingId: z.string(),
  bridgeId: z.string(),
  bridgeName: z.string(),
  secret: z.string(),
  hosts: phoneHostsSchema,
  lastHost: z.string().nullable(),
  relay: z.object({ url: z.string(), room: z.string() }).nullable(),
});

/**
 * Long-term trust the phone keeps for one bridge after a pairing; ids and secret are base64. `hosts` are the addresses
 * the bridge last announced, `lastHost` the one that last reached it, `relay` the rendezvous of a QR pairing, if any.
 */
export type PhonePairing = z.infer<typeof phonePairingSchema>;

/** What a pairing session learns; the caller adds how it reached the bridge. */
export type LearnedPairing = Omit<PhonePairing, "lastHost" | "relay">;

/** Secret the phone pairs with: its own displayed code, or the token of a scanned QR code bound to the bridge that issued it. */
export type PhoneSecret = { readonly kind: "code"; readonly code: string } | { readonly kind: "token"; readonly token: Uint8Array; readonly bridgeId: string };

const phoneRevocationSchema = z.object({
  bridgeId: z.string(),
  pairingId: z.string(),
  proof: z.string(),
});

/** What remains of a forgotten pairing until the bridge has been told to drop it. */
export type PhoneRevocation = z.infer<typeof phoneRevocationSchema>;

function parseStored(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function parsePhonePairing(text: string): PhonePairing | null {
  const parsed = phonePairingSchema.safeParse(parseStored(text));
  return parsed.success ? parsed.data : null;
}

export function parsePhoneRevocation(text: string): PhoneRevocation | null {
  const parsed = phoneRevocationSchema.safeParse(parseStored(text));
  return parsed.success ? parsed.data : null;
}

export function phoneRevocation(pairing: PhonePairing): PhoneRevocation {
  const pairingId = decodeBytes(pairing.pairingId, identityBytes);
  const proof = revocationProof(decodeBytes(pairing.secret, pairingSecretBytes), pairingId);
  return { bridgeId: pairing.bridgeId, pairingId: pairing.pairingId, proof: toBase64(proof) };
}

export interface PhoneSessionHandlers {
  readonly onStatus: (status: PhoneLinkStatus) => void;
  readonly onOpen: (peer: ConnectionPeer) => Id;
  readonly onClient: (connectionId: Id, client: string) => void;
  readonly onCall: (connectionId: Id, tool: string, args: Readonly<Record<string, unknown>>) => ToolOutcome;
  readonly onRejected: (reason: RejectionReason) => void;
  readonly onPaired: (pairing: LearnedPairing) => void;
  readonly onHosts: (hosts: readonly string[]) => void;
  readonly onRevocationAcknowledged: (revocation: PhoneRevocation) => void;
}

export interface PhoneSessionOptions {
  readonly secret: PhoneSecret;
  readonly device: string;
  readonly deviceId: string;
  readonly pairing: PhonePairing | null;
  /** Whether a phone holding `pairing` may pair with the code when another bridge answers, instead of refusing it. */
  readonly pairOtherBridges: boolean;
  readonly revocation: PhoneRevocation | null;
  readonly randomBytes: RandomBytes;
  readonly now: () => number;
  readonly socket: PhoneSocket;
  readonly handlers: PhoneSessionHandlers;
}

interface DerivedPairing {
  readonly pairingId: string;
  readonly bridgeId: string;
  readonly secret: string;
}

type DerivedSecrets = { readonly kind: "ready"; readonly secrets: PairingSecrets } | { readonly kind: "failed"; readonly error: unknown };

async function settledSecrets(derivation: Promise<PairingSecrets>): Promise<DerivedSecrets> {
  try {
    return { kind: "ready", secrets: await derivation };
  } catch (error) {
    return { kind: "failed", error };
  }
}

type SessionState =
  | { readonly kind: "challenge" }
  | { readonly kind: "proving" }
  | { readonly kind: "waiting"; readonly secrets: Promise<DerivedSecrets>; readonly bridgeId: string; commitment: Uint8Array | null }
  | { readonly kind: "resuming"; readonly secrets: HandshakeSecrets }
  | { readonly kind: "open"; readonly channel: SealedChannel }
  | { readonly kind: "closed" };

/** Surfaces a failed derivation where the secrets are needed, so it is never lost while no commit arrives. */
function readySecrets(derived: DerivedSecrets): PairingSecrets {
  switch (derived.kind) {
    case "ready":
      return derived.secrets;
    case "failed":
      throw derived.error;
    default: {
      const unreachable: never = derived;
      throw new Error(`Unhandled derivation ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Phone side of the bridge link: pairs with a code or a QR token, or resumes a trusted pairing, then serves sealed JSON-RPC requests from the bridge. */
export class PhoneSession {
  private readonly options: PhoneSessionOptions;
  private state: SessionState = { kind: "challenge" };
  private opened: Id | null = null;
  private learned: DerivedPairing | null = null;
  private unacknowledged: PhoneRevocation | null = null;
  private proofSent = false;
  private queue: Promise<void> = Promise.resolve();
  private lastReceivedAt: number;

  constructor(options: PhoneSessionOptions) {
    this.options = options;
    this.lastReceivedAt = options.now();
  }

  /** Connection opened through this session, kept after the session closes so callers can record how it ended. */
  get connectionId(): Id | null {
    return this.opened;
  }

  /** True once a secret-derived proof left the phone: a code can then be cracked offline and must not be reused. */
  get codeExposed(): boolean {
    return this.proofSent;
  }

  get isClosed(): boolean {
    return this.state.kind === "closed";
  }

  isStale(now: number): boolean {
    return this.state.kind === "open" && now - this.lastReceivedAt > heartbeatTimeoutMs;
  }

  /**
   * Handles one frame from the bridge, after every frame received before it. Rejects with a ProtocolError when the bridge
   * breaks the protocol; when a tool handler throws, the session replies with an internal error, closes with reason
   * `error` and rejects with that error.
   */
  receive(text: string): Promise<void> {
    const handled = this.queue.then(() => this.process(text));
    // The caller gets the failure through `handled`; the queue only has to keep going.
    this.queue = handled.catch(() => undefined);
    return handled;
  }

  private async process(text: string): Promise<void> {
    if (this.state.kind === "closed") return;
    this.lastReceivedAt = this.options.now();
    const frame = decodeFrame(text);
    this.acknowledgeRevocation(frame);
    switch (frame.type) {
      case "challenge":
        await this.answerChallenge(frame);
        return;
      case "commit":
        await this.answerCommit(frame);
        return;
      case "welcome":
        await this.acceptWelcome(frame);
        return;
      case "resumed":
        this.acceptResumed(frame);
        return;
      case "rejected":
        this.state = { kind: "closed" };
        this.options.socket.close();
        this.options.handlers.onRejected(frame.reason);
        this.options.handlers.onStatus("closed");
        return;
      case "sealed": {
        if (this.state.kind !== "open") throw new ProtocolError("Sealed frame before pairing");
        const state = this.state;
        this.handle(state, parseBridgeMessage(state.channel.open(frame)));
        return;
      }
      case "hello":
      case "proof":
      case "resume":
      case "revoke":
        throw new ProtocolError(`Unexpected ${frame.type} from the bridge`);
      default: {
        const unreachable: never = frame;
        throw new ProtocolError(`Unhandled frame ${JSON.stringify(unreachable)}`);
      }
    }
  }

  close(reason: ConnectionEndReason): void {
    if (this.state.kind === "closed") return;
    if (this.state.kind === "open") this.send(this.state.channel.seal({ jsonrpc: "2.0", method: "session.close", params: { reason } } satisfies PhoneMessage));
    this.state = { kind: "closed" };
    this.options.socket.close();
    this.options.handlers.onStatus("closed");
  }

  markClosed(): void {
    if (this.state.kind === "closed") return;
    this.state = { kind: "closed" };
    this.options.handlers.onStatus("closed");
  }

  private send(frame: Frame): void {
    this.options.socket.send(encodeFrame(frame));
  }

  /**
   * The bridge reads frames in order and drops the socket when it refuses a revocation, so a frame it sends after the
   * revoke proves it was applied. A `replaced` rejection is the exception: the bridge can send it before reading the revoke.
   */
  private acknowledgeRevocation(frame: Frame): void {
    const revocation = this.unacknowledged;
    if (revocation === null || (frame.type === "rejected" && frame.reason === "replaced")) return;
    this.unacknowledged = null;
    this.options.handlers.onRevocationAcknowledged(revocation);
  }

  private async answerChallenge(frame: Extract<Frame, { type: "challenge" }>): Promise<void> {
    if (this.state.kind !== "challenge") throw new ProtocolError("Unexpected challenge");
    if (frame.version !== protocolVersion) {
      this.state = { kind: "closed" };
      this.options.socket.close();
      this.options.handlers.onRejected("version");
      this.options.handlers.onStatus("closed");
      return;
    }
    const bridgeId = decodeBytes(frame.bridge, identityBytes);
    const secret = this.options.secret;
    if (secret.kind === "token" && !sameBytes(decodeBytes(secret.bridgeId, identityBytes), bridgeId)) throw new ProtocolError("This bridge did not issue the scanned QR code");
    const revocation = this.options.revocation;
    if (revocation !== null && sameBytes(decodeBytes(revocation.bridgeId), bridgeId)) {
      this.send({ type: "revoke", pairing: revocation.pairingId, proof: revocation.proof });
      this.unacknowledged = revocation;
    }
    const keyPair = generateEphemeralKeyPair(this.options.randomBytes);
    const transcript: PairingTranscript = {
      bridgeId,
      bridgeNonce: decodeBytes(frame.nonce, nonceBytes),
      bridgeKey: decodeBytes(frame.key, publicKeyBytes),
      deviceId: decodeBytes(this.options.deviceId, identityBytes),
      phoneNonce: this.options.randomBytes(nonceBytes),
      phoneKey: keyPair.publicKey,
      device: this.options.device,
    };
    const shared = sharedSecret(keyPair.secretKey, transcript.bridgeKey);
    const pairing = this.options.pairing;
    if (pairing !== null && sameBytes(decodeBytes(pairing.bridgeId), bridgeId)) {
      this.resume(pairing, transcript, shared);
      return;
    }
    if (pairing !== null && !this.options.pairOtherBridges) throw new ForeignBridgeError("Another bridge answered on the address of the trusted Mac");
    this.state = { kind: "proving" };
    this.options.handlers.onStatus("proving");
    this.send({
      type: "hello",
      version: protocolVersion,
      secret: secret.kind,
      device: transcript.device,
      deviceId: this.options.deviceId,
      nonce: toBase64(transcript.phoneNonce),
      key: toBase64(transcript.phoneKey),
    });
    const secrets = settledSecrets(derivePairingSecrets(secret, transcript, shared));
    this.state = { kind: "waiting", secrets, bridgeId: frame.bridge, commitment: null };
    this.options.handlers.onStatus("waiting");
  }

  private resume(pairing: PhonePairing, transcript: PairingTranscript, shared: Uint8Array): void {
    const pairingId = decodeBytes(pairing.pairingId, identityBytes);
    const secrets = deriveResumeSecrets(decodeBytes(pairing.secret, pairingSecretBytes), { ...transcript, pairingId }, shared);
    this.state = { kind: "resuming", secrets };
    this.options.handlers.onStatus("resuming");
    this.send({
      type: "resume",
      version: protocolVersion,
      device: transcript.device,
      deviceId: this.options.deviceId,
      pairing: pairing.pairingId,
      nonce: toBase64(transcript.phoneNonce),
      key: toBase64(transcript.phoneKey),
      proof: toBase64(resumePhoneProof(secrets)),
    });
  }

  /** Scrypt can take seconds on a phone, so the hello leaves first and the proof waits for the derived secrets. */
  private async answerCommit(frame: Extract<Frame, { type: "commit" }>): Promise<void> {
    const state = this.state;
    if (state.kind !== "waiting") throw new ProtocolError("Unexpected commit");
    const commitment = decodeBytes(frame.commitment, proofBytes);
    state.commitment = commitment;
    const secrets = readySecrets(await state.secrets);
    if (this.state !== state) return;
    this.proofSent = true;
    this.send({ type: "proof", proof: toBase64(phoneProof(secrets, commitment)) });
  }

  private async acceptWelcome(frame: Extract<Frame, { type: "welcome" }>): Promise<void> {
    const state = this.state;
    if (state.kind !== "waiting" || state.commitment === null) throw new ProtocolError("Unexpected welcome");
    const commitment = state.commitment;
    const secrets = readySecrets(await state.secrets);
    if (this.state !== state) return;
    const proof = decodeBytes(frame.proof, proofBytes);
    const opened = sameBytes(commitBridgeProof(decodeBytes(frame.opening, openingBytes), proof), commitment);
    if (!opened || !sameBytes(proof, bridgeProof(secrets))) throw new ProtocolError("The bridge could not prove it knows the pairing secret");
    this.learned = { pairingId: toBase64(secrets.pairingId), bridgeId: state.bridgeId, secret: toBase64(secrets.pairingSecret) };
    this.state = { kind: "open", channel: new SealedChannel(secrets.sessionKeys.toBridge, secrets.sessionKeys.toPhone) };
  }

  private acceptResumed(frame: Extract<Frame, { type: "resumed" }>): void {
    const state = this.state;
    if (state.kind !== "resuming") throw new ProtocolError("Unexpected resumed");
    if (!sameBytes(decodeBytes(frame.proof, proofBytes), resumeBridgeProof(state.secrets))) throw new ProtocolError("The bridge could not prove it holds the pairing");
    this.state = { kind: "open", channel: new SealedChannel(state.secrets.sessionKeys.toBridge, state.secrets.sessionKeys.toPhone) };
  }

  private reply(state: Extract<SessionState, { kind: "open" }>, message: PhoneMessage): void {
    this.send(state.channel.seal(message));
  }

  private handle(state: Extract<SessionState, { kind: "open" }>, message: BridgeMessage): void {
    switch (message.method) {
      case "session.open": {
        this.opened ??= this.options.handlers.onOpen(message.params);
        const learned = this.learned;
        this.learned = null;
        if (learned !== null) this.options.handlers.onPaired({ ...learned, bridgeName: message.params.host, hosts: message.params.hosts });
        else this.options.handlers.onHosts(message.params.hosts);
        this.reply(state, { jsonrpc: "2.0", id: message.id, result: { connectionId: this.opened } });
        this.options.handlers.onStatus("open");
        return;
      }
      case "session.client":
        if (this.opened !== null) this.options.handlers.onClient(this.opened, message.params.client);
        return;
      case "session.hosts":
        this.options.handlers.onHosts(message.params.hosts);
        return;
      case "ping":
        return;
      case "tools/call": {
        const connectionId = this.opened;
        if (connectionId === null) {
          this.reply(state, { jsonrpc: "2.0", id: message.id, error: { code: rpcErrorCodes.notOpen, message: "Session not open" } });
          return;
        }
        let outcome: ToolOutcome | null = null;
        try {
          outcome = this.options.handlers.onCall(connectionId, message.params.name, message.params.arguments);
        } finally {
          if (outcome === null) {
            this.reply(state, { jsonrpc: "2.0", id: message.id, error: { code: rpcErrorCodes.internal, message: "The phone failed to run the tool" } });
            this.close("error");
          } else {
            this.reply(state, { jsonrpc: "2.0", id: message.id, result: outcome });
          }
        }
        return;
      }
      default: {
        const unreachable: never = message;
        throw new ProtocolError(`Unhandled bridge message ${JSON.stringify(unreachable)}`);
      }
    }
  }
}
