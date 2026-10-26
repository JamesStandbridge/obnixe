import type { RawData, WebSocket } from "ws";

/** One phone connection as PhoneEndpoint sees it, whether the phone dialed the bridge directly or came through the relay. */
export interface PeerSocket {
  /** Key of the flood rules on pending handshakes: the remote address of a direct socket, the room of a relayed peer. */
  readonly origin: string;
  onmessage: ((text: string) => void) | null;
  onclose: (() => void) | null;
  send(text: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
  /** Called once per heartbeat; false when the peer did not answer the previous one. */
  heartbeat(): boolean;
}

const policyViolation = 1008;

export function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/** A WebSocket the phone dialed on the direct listener; binary frames are not part of the protocol and close it. */
export class DirectPeer implements PeerSocket {
  readonly origin: string;
  onmessage: ((text: string) => void) | null = null;
  onclose: (() => void) | null = null;
  private readonly socket: WebSocket;
  private alive = true;

  constructor(socket: WebSocket, origin: string) {
    this.socket = socket;
    this.origin = origin;
    socket.on("message", (data, isBinary) => {
      if (isBinary) socket.close(policyViolation, "protocol");
      else this.onmessage?.(rawText(data));
    });
    socket.on("close", () => this.onclose?.());
    socket.on("pong", () => {
      this.alive = true;
    });
  }

  send(text: string): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(text);
  }

  close(code: number, reason: string): void {
    this.socket.close(code, reason);
  }

  terminate(): void {
    this.socket.terminate();
  }

  heartbeat(): boolean {
    if (!this.alive) return false;
    this.alive = false;
    this.socket.ping();
    return true;
  }
}
