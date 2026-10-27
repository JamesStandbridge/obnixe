import { ProtocolError, encodeRelayMessage, parseRelayToPhone, relayPeerLeftMessage, relayProtocolVersion, relaySocketUrl } from "@obnixe/core";
import type { RelayRefusal, RelayToPhone } from "@obnixe/core";
import type { LinkSocket } from "@/features/agent/socket";

export const relayJoinTimeoutMs = 10_000;

/**
 * `peer`: the relay paired the phone with the bridge of the room; the socket then carries the bridge protocol.
 * `refused`: the relay turned the join down. `timeout`: no bridge joined the room in time. `unreachable`: the relay
 * could not be reached or broke its protocol. `cancelled`: the caller gave up first.
 */
export type RelayDialResult =
  | { readonly kind: "peer"; readonly socket: LinkSocket }
  | { readonly kind: "refused"; readonly reason: RelayRefusal }
  | { readonly kind: "timeout" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "cancelled" };

export interface RelayDial {
  readonly result: Promise<RelayDialResult>;
  /** Abandons the dial while it waits for a peer; once it resolved with a socket, close that socket instead. */
  readonly cancel: () => void;
}

export interface RelayDialOptions {
  readonly relayUrl: string;
  readonly room: string;
  readonly joinTimeoutMs?: number;
}

/** Bridge frames delivered by the relay; holds those that arrive before `onmessage` is set. */
class RelayedSocket implements LinkSocket {
  onclose: (() => void) | null = null;
  private readonly socket: WebSocket;
  private readonly backlog: string[] = [];
  private handler: ((text: string) => void) | null = null;
  private ended = false;

  constructor(socket: WebSocket) {
    this.socket = socket;
  }

  get onmessage(): ((text: string) => void) | null {
    return this.handler;
  }

  set onmessage(handler: ((text: string) => void) | null) {
    this.handler = handler;
    while (this.handler !== null && this.backlog.length > 0) {
      const text = this.backlog.shift();
      if (text !== undefined) this.handler(text);
    }
  }

  send(text: string): void {
    this.socket.send(text);
  }

  close(): void {
    this.socket.close();
  }

  receive(text: string): void {
    if (text === relayPeerLeftMessage) {
      this.socket.close();
      return;
    }
    if (this.handler === null) this.backlog.push(text);
    else this.handler(text);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.onclose?.();
  }
}

/** Joins `room` on the relay as the phone and resolves once the relay paired it with the bridge of that room. */
export function dialRelay(options: RelayDialOptions): RelayDial {
  const socket = new WebSocket(relaySocketUrl(options.relayUrl));
  let relayed: RelayedSocket | null = null;
  let settle: ((result: RelayDialResult) => void) | null = null;
  const result = new Promise<RelayDialResult>((resolve) => {
    settle = resolve;
  });
  const finish = (outcome: RelayDialResult): void => {
    clearTimeout(timer);
    const resolve = settle;
    settle = null;
    resolve?.(outcome);
  };
  const abandon = (outcome: RelayDialResult): void => {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
    finish(outcome);
  };
  const timer = setTimeout(() => abandon({ kind: "timeout" }), options.joinTimeoutMs ?? relayJoinTimeoutMs);

  socket.onopen = () => socket.send(encodeRelayMessage({ type: "join", v: relayProtocolVersion, role: "phone", room: options.room }));
  socket.onmessage = (event: MessageEvent) => {
    const text = String(event.data);
    if (relayed !== null) {
      relayed.receive(text);
      return;
    }
    let notice: RelayToPhone;
    try {
      notice = parseRelayToPhone(text);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      abandon({ kind: "unreachable" });
      return;
    }
    switch (notice.type) {
      case "peer":
        relayed = new RelayedSocket(socket);
        finish({ kind: "peer", socket: relayed });
        return;
      case "refused":
        abandon({ kind: "refused", reason: notice.reason });
        return;
      case "peer_left":
        abandon({ kind: "unreachable" });
        return;
      default: {
        const unreachable: never = notice;
        throw new Error(`Unhandled relay notice ${JSON.stringify(unreachable)}`);
      }
    }
  };
  socket.onclose = () => {
    if (relayed !== null) relayed.end();
    else finish({ kind: "unreachable" });
  };
  socket.onerror = () => {
    if (relayed !== null) relayed.end();
    else abandon({ kind: "unreachable" });
  };

  return {
    result,
    cancel: () => {
      if (relayed === null) abandon({ kind: "cancelled" });
    },
  };
}
