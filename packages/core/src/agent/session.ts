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
  encodeFrame,
  generateEphemeralKeyPair,
  heartbeatTimeoutMs,
  nonceBytes,
  openingBytes,
  parseBridgeMessage,
  phoneProof,
  proofBytes,
  protocolVersion,
  publicKeyBytes,
  rpcErrorCodes,
  sharedSecret,
} from "./protocol.ts";
import type { BridgeMessage, Frame, PairingSecrets, PairingTranscript, PhoneMessage, RandomBytes, RejectionReason, ToolOutcome } from "./protocol.ts";
import { toBase64 } from "./encoding.ts";

export type PhoneLinkStatus = "proving" | "waiting" | "open" | "closed";

export interface PhoneSocket {
  readonly send: (text: string) => void;
  readonly close: () => void;
}

export interface PhoneSessionHandlers {
  readonly onStatus: (status: PhoneLinkStatus) => void;
  readonly onOpen: (peer: ConnectionPeer) => Id;
  readonly onClient: (connectionId: Id, client: string) => void;
  readonly onCall: (connectionId: Id, tool: string, args: Readonly<Record<string, unknown>>) => ToolOutcome;
  readonly onRejected: (reason: RejectionReason) => void;
}

export interface PhoneSessionOptions {
  readonly code: string;
  readonly device: string;
  readonly randomBytes: RandomBytes;
  readonly now: () => number;
  readonly socket: PhoneSocket;
  readonly handlers: PhoneSessionHandlers;
}

type SessionState =
  | { readonly kind: "challenge" }
  | { readonly kind: "proving" }
  | { readonly kind: "waiting"; readonly secrets: Promise<PairingSecrets>; commitment: Uint8Array | null }
  | { readonly kind: "open"; readonly channel: SealedChannel }
  | { readonly kind: "closed" };

/** Phone side of the bridge link: answers the pairing challenge, then serves sealed JSON-RPC requests from the bridge. */
export class PhoneSession {
  private readonly options: PhoneSessionOptions;
  private state: SessionState = { kind: "challenge" };
  private opened: Id | null = null;
  private proofSent = false;
  private lastReceivedAt: number;

  constructor(options: PhoneSessionOptions) {
    this.options = options;
    this.lastReceivedAt = options.now();
  }

  /** Connection opened through this session, kept after the session closes so callers can record how it ended. */
  get connectionId(): Id | null {
    return this.opened;
  }

  /** True once a code-derived proof left the phone: the code can then be cracked offline and must not be reused. */
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
   * Handles one frame from the bridge. Rejects with a ProtocolError when the bridge breaks the protocol; when a tool
   * handler throws, the session replies with an internal error, closes with reason `error` and rejects with that error.
   */
  async receive(text: string): Promise<void> {
    if (this.state.kind === "closed") return;
    this.lastReceivedAt = this.options.now();
    const frame = decodeFrame(text);
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

  private async answerChallenge(frame: Extract<Frame, { type: "challenge" }>): Promise<void> {
    if (this.state.kind !== "challenge") throw new ProtocolError("Unexpected challenge");
    if (frame.version !== protocolVersion) {
      this.state = { kind: "closed" };
      this.options.socket.close();
      this.options.handlers.onRejected("version");
      this.options.handlers.onStatus("closed");
      return;
    }
    const keyPair = generateEphemeralKeyPair(this.options.randomBytes);
    const transcript: PairingTranscript = {
      bridgeNonce: decodeBytes(frame.nonce, nonceBytes),
      bridgeKey: decodeBytes(frame.key, publicKeyBytes),
      phoneNonce: this.options.randomBytes(nonceBytes),
      phoneKey: keyPair.publicKey,
      device: this.options.device,
    };
    const shared = sharedSecret(keyPair.secretKey, transcript.bridgeKey);
    this.state = { kind: "proving" };
    this.options.handlers.onStatus("proving");
    this.send({ type: "hello", version: protocolVersion, device: transcript.device, nonce: toBase64(transcript.phoneNonce), key: toBase64(transcript.phoneKey) });
    const secrets = derivePairingSecrets(this.options.code, transcript, shared);
    // Awaited on commit; this only keeps a failure before the commit from surfacing as an unhandled rejection.
    secrets.catch(() => undefined);
    this.state = { kind: "waiting", secrets, commitment: null };
    this.options.handlers.onStatus("waiting");
  }

  /** Scrypt can take seconds on a phone, so the hello leaves first and the proof waits for the derived secrets. */
  private async answerCommit(frame: Extract<Frame, { type: "commit" }>): Promise<void> {
    const state = this.state;
    if (state.kind !== "waiting") throw new ProtocolError("Unexpected commit");
    const commitment = decodeBytes(frame.commitment, proofBytes);
    state.commitment = commitment;
    const secrets = await state.secrets;
    if (this.state !== state) return;
    this.proofSent = true;
    this.send({ type: "proof", proof: toBase64(phoneProof(secrets, commitment)) });
  }

  private async acceptWelcome(frame: Extract<Frame, { type: "welcome" }>): Promise<void> {
    const state = this.state;
    if (state.kind !== "waiting" || state.commitment === null) throw new ProtocolError("Unexpected welcome");
    const commitment = state.commitment;
    const secrets = await state.secrets;
    if (this.state !== state) return;
    const proof = decodeBytes(frame.proof, proofBytes);
    const opened = sameBytes(commitBridgeProof(decodeBytes(frame.opening, openingBytes), proof), commitment);
    if (!opened || !sameBytes(proof, bridgeProof(secrets))) throw new ProtocolError("The bridge could not prove it knows the code");
    this.state = { kind: "open", channel: new SealedChannel(secrets.sessionKeys.toBridge, secrets.sessionKeys.toPhone) };
  }

  private reply(state: Extract<SessionState, { kind: "open" }>, message: PhoneMessage): void {
    this.send(state.channel.seal(message));
  }

  private handle(state: Extract<SessionState, { kind: "open" }>, message: BridgeMessage): void {
    switch (message.method) {
      case "session.open": {
        this.opened ??= this.options.handlers.onOpen(message.params);
        this.reply(state, { jsonrpc: "2.0", id: message.id, result: { connectionId: this.opened } });
        this.options.handlers.onStatus("open");
        return;
      }
      case "session.client":
        if (this.opened !== null) this.options.handlers.onClient(this.opened, message.params.client);
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
