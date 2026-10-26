import type { ConnectionEndReason, Id } from "@obnixe/schema";
import type { ConnectionPeer } from "./connection.ts";
import {
  ProtocolError,
  SealedChannel,
  decodeBytes,
  decodeFrame,
  derivePairingKey,
  deriveSessionKeys,
  encodeFrame,
  heartbeatTimeoutMs,
  helloProof,
  nonceBytes,
  parseBridgeMessage,
  protocolVersion,
  rpcErrorCodes,
  sameBytes,
  welcomeProof,
} from "./protocol.ts";
import type { BridgeMessage, Frame, PairingTranscript, PhoneMessage, RandomBytes, RejectionReason, ToolOutcome } from "./protocol.ts";
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
  | { readonly kind: "waiting"; readonly transcript: PairingTranscript; readonly key: Uint8Array }
  | { readonly kind: "open"; readonly channel: SealedChannel; connectionId: Id | null }
  | { readonly kind: "closed" };

/** Phone side of the bridge link: answers the pairing challenge, then serves sealed JSON-RPC requests from the bridge. */
export class PhoneSession {
  private readonly options: PhoneSessionOptions;
  private state: SessionState = { kind: "challenge" };
  private lastReceivedAt: number;

  constructor(options: PhoneSessionOptions) {
    this.options = options;
    this.lastReceivedAt = options.now();
  }

  get connectionId(): Id | null {
    return this.state.kind === "open" ? this.state.connectionId : null;
  }

  get isClosed(): boolean {
    return this.state.kind === "closed";
  }

  isStale(now: number): boolean {
    return this.state.kind === "open" && now - this.lastReceivedAt > heartbeatTimeoutMs;
  }

  async receive(text: string): Promise<void> {
    if (this.state.kind === "closed") return;
    this.lastReceivedAt = this.options.now();
    const frame = decodeFrame(text);
    switch (frame.type) {
      case "challenge":
        await this.answerChallenge(frame);
        return;
      case "welcome":
        this.acceptWelcome(frame);
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
        throw new ProtocolError("Unexpected hello from the bridge");
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
    const transcript: PairingTranscript = { bridgeNonce: decodeBytes(frame.nonce, nonceBytes), phoneNonce: this.options.randomBytes(nonceBytes), device: this.options.device };
    this.state = { kind: "proving" };
    this.options.handlers.onStatus("proving");
    const key = await derivePairingKey(this.options.code, transcript);
    if (this.state.kind !== "proving") return;
    this.send({ type: "hello", version: protocolVersion, device: transcript.device, nonce: toBase64(transcript.phoneNonce), proof: toBase64(helloProof(key, transcript)) });
    this.state = { kind: "waiting", transcript, key };
    this.options.handlers.onStatus("waiting");
  }

  private acceptWelcome(frame: Extract<Frame, { type: "welcome" }>): void {
    if (this.state.kind !== "waiting") throw new ProtocolError("Unexpected welcome");
    const { key, transcript } = this.state;
    if (!sameBytes(decodeBytes(frame.proof), welcomeProof(key, transcript))) throw new ProtocolError("The bridge could not prove it knows the code");
    const keys = deriveSessionKeys(key, transcript);
    this.state = { kind: "open", channel: new SealedChannel(keys.toBridge, keys.toPhone), connectionId: null };
  }

  private reply(state: Extract<SessionState, { kind: "open" }>, message: PhoneMessage): void {
    this.send(state.channel.seal(message));
  }

  private handle(state: Extract<SessionState, { kind: "open" }>, message: BridgeMessage): void {
    switch (message.method) {
      case "session.open": {
        state.connectionId ??= this.options.handlers.onOpen(message.params);
        this.reply(state, { jsonrpc: "2.0", id: message.id, result: { connectionId: state.connectionId } });
        this.options.handlers.onStatus("open");
        return;
      }
      case "session.client":
        if (state.connectionId !== null) this.options.handlers.onClient(state.connectionId, message.params.client);
        return;
      case "ping":
        return;
      case "tools/call": {
        const connectionId = state.connectionId;
        if (connectionId === null) {
          this.reply(state, { jsonrpc: "2.0", id: message.id, error: { code: rpcErrorCodes.notOpen, message: "Session not open" } });
          return;
        }
        let outcome: ToolOutcome | null = null;
        try {
          outcome = this.options.handlers.onCall(connectionId, message.params.name, message.params.arguments);
        } finally {
          this.reply(
            state,
            outcome === null
              ? { jsonrpc: "2.0", id: message.id, error: { code: rpcErrorCodes.internal, message: "The phone failed to run the tool" } }
              : { jsonrpc: "2.0", id: message.id, result: outcome },
          );
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
