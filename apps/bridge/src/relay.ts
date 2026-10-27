import { unwatchFile, watchFile } from "node:fs";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { ProtocolError, encodeRelayMessage, maxRelayMessageBytes, generateRelayRoom, pairingRelayRoom, parseRelayToBridge, relayProtocolVersion, relaySocketUrl } from "@obnixe/core/agent/wire";
import type { RandomBytes, RelayClientMessage, RelayRefusal, RelayToBridge } from "@obnixe/core/agent/wire";
import { PairingFileError } from "./pairings.ts";
import type { PairingFile } from "./pairings.ts";
import { rawText } from "./peer.ts";
import type { PeerSocket } from "./peer.ts";

const defaultFirstRetryMs = 1000;
const maxRetryMs = 60_000;
const rejoinMs = 10_000;
const watchIntervalMs = 2000;
const stableMs = 30_000;

/** What a QR invite needs so a new phone can reach this bridge through the relay. */
export interface RelayInvite {
  readonly relayUrl: string;
  readonly room: string;
}

export interface RelayLinkOptions {
  readonly relayUrl: string;
  readonly pairings: PairingFile;
  readonly randomBytes: RandomBytes;
  readonly onPeer: (peer: PeerSocket) => void;
  readonly log: (line: string) => void;
  readonly firstRetryMs?: number;
}

type RoomKind = "pairing" | "invite";

type Reachability = "unknown" | "up" | "down";

interface RoomState {
  readonly room: string;
  readonly kind: RoomKind;
  joined: boolean;
  peer: RelayedPeer | null;
  /** An invite closed while its phone is still connected: the room is left once that phone goes. */
  leaving: boolean;
  warned: boolean;
  rejoin: ReturnType<typeof setTimeout> | null;
}

/** A phone reached through one relay room. The relay pings the phone itself and reports a dead one with `peer_left`. */
class RelayedPeer implements PeerSocket {
  readonly transport = "relay";
  readonly origin: string;
  onmessage: ((text: string) => void) | null = null;
  onclose: (() => void) | null = null;
  private readonly room: string;
  private readonly transmit: (message: RelayClientMessage) => void;
  private ended = false;

  constructor(room: string, transmit: (message: RelayClientMessage) => void) {
    this.room = room;
    this.origin = `relay:${room}`;
    this.transmit = transmit;
  }

  send(text: string): void {
    if (!this.ended) this.transmit({ type: "frame", room: this.room, data: text });
  }

  close(): void {
    if (!this.ended) this.transmit({ type: "close", room: this.room });
  }

  terminate(): void {
    this.close();
  }

  heartbeat(): boolean {
    return true;
  }

  deliver(text: string): void {
    if (!this.ended) this.onmessage?.(text);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.onclose?.();
  }
}

/**
 * Outgoing connection to the relay: joins the room of every stored pairing and of the pending invite, and hands each phone
 * the relay pairs with this bridge to PhoneEndpoint like a freshly accepted socket. Reconnects with backoff.
 */
export class RelayLink {
  private readonly options: RelayLinkOptions;
  private readonly rooms = new Map<string, RoomState>();
  private socket: WebSocket | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private stable: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private invite: string | null = null;
  private reachability: Reachability = "unknown";
  private stopped = false;

  constructor(options: RelayLinkOptions) {
    this.options = options;
  }

  start(): void {
    watchFile(this.options.pairings.path, { interval: watchIntervalMs, persistent: false }, () => this.sync());
    this.sync();
    this.connect();
  }

  /** Opens a fresh one-time room for a QR invite, replacing any pending one. */
  openInvite(): RelayInvite {
    this.invite = generateRelayRoom(this.options.randomBytes);
    this.sync();
    return { relayUrl: this.options.relayUrl, room: this.invite };
  }

  /** Stops admitting phones through the invite room; a phone already connected in it keeps its session. */
  closeInvite(): void {
    this.invite = null;
    this.sync();
  }

  /** Joins and leaves rooms to match the stored pairings and the pending invite. */
  sync(): void {
    if (this.stopped) return;
    let wanted: Set<string>;
    try {
      wanted = this.wantedRooms();
    } catch (error) {
      if (!(error instanceof PairingFileError)) throw error;
      this.options.log(`Relay rooms not updated: ${error.message}`);
      return;
    }
    for (const state of [...this.rooms.values()]) {
      if (!wanted.has(state.room)) this.leave(state);
    }
    for (const room of wanted) {
      if (!this.rooms.has(room)) this.add(room, room === this.invite ? "invite" : "pairing");
    }
  }

  close(): void {
    this.stopped = true;
    unwatchFile(this.options.pairings.path);
    if (this.reconnect !== null) clearTimeout(this.reconnect);
    this.reconnect = null;
    if (this.stable !== null) clearTimeout(this.stable);
    this.stable = null;
    for (const state of this.rooms.values()) this.release(state);
    this.rooms.clear();
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
  }

  private wantedRooms(): Set<string> {
    const rooms = new Set<string>();
    for (const pairing of this.options.pairings.list()) {
      try {
        rooms.add(pairingRelayRoom(pairing));
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        this.options.log(`Skipped a malformed pairing of ${pairing.device} for the relay: ${error.message}`);
      }
    }
    if (this.invite !== null) rooms.add(this.invite);
    return rooms;
  }

  private add(room: string, kind: RoomKind): void {
    const state: RoomState = { room, kind, joined: false, peer: null, leaving: false, warned: false, rejoin: null };
    this.rooms.set(room, state);
    this.join(state);
  }

  private join(state: RoomState): void {
    if (state.rejoin !== null) clearTimeout(state.rejoin);
    state.rejoin = null;
    this.transmit({ type: "join", v: relayProtocolVersion, role: "bridge", room: state.room });
  }

  private leave(state: RoomState): void {
    if (state.kind === "invite" && state.peer !== null) {
      state.leaving = true;
      return;
    }
    this.rooms.delete(state.room);
    this.transmit({ type: "leave", room: state.room });
    this.release(state);
  }

  private release(state: RoomState): void {
    if (state.rejoin !== null) clearTimeout(state.rejoin);
    state.rejoin = null;
    state.joined = false;
    const peer = state.peer;
    state.peer = null;
    peer?.end();
  }

  private transmit(message: RelayClientMessage): void {
    const socket = this.socket;
    if (socket !== null && socket.readyState === socket.OPEN) socket.send(encodeRelayMessage(message));
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(relaySocketUrl(this.options.relayUrl), { maxPayload: maxRelayMessageBytes });
    this.socket = socket;
    socket.on("open", () => {
      // An open alone does not reset the backoff: a relay that accepts and drops at once would otherwise be hammered.
      this.stable = setTimeout(() => {
        this.stable = null;
        this.retries = 0;
      }, stableMs);
      for (const state of this.rooms.values()) this.join(state);
    });
    socket.on("message", (data, isBinary) => this.receive(socket, data, isBinary));
    socket.on("close", () => this.disconnected(socket));
    socket.on("error", (error) => {
      if (socket === this.socket) this.announce("down", `Cannot reach the relay ${this.options.relayUrl} (${error.message}); retrying in the background.`);
    });
  }

  private receive(socket: WebSocket, data: RawData, isBinary: boolean): void {
    if (socket !== this.socket) return;
    let message: RelayToBridge;
    try {
      if (isBinary) throw new ProtocolError("Binary frames are not part of the relay protocol");
      message = parseRelayToBridge(rawText(data));
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      this.options.log(`The relay sent an invalid message (${error.message}); reconnecting.`);
      socket.terminate();
      return;
    }
    this.handle(message);
  }

  private handle(message: RelayToBridge): void {
    const state = this.rooms.get(message.room);
    switch (message.type) {
      case "joined":
        if (state !== undefined) state.joined = true;
        this.retries = 0;
        this.announce("up", `Reachable through the relay ${this.options.relayUrl}.`);
        return;
      case "refused":
        if (state !== undefined) this.refused(state, message.reason);
        return;
      case "peer": {
        if (state === undefined) return;
        state.peer?.end();
        const peer = new RelayedPeer(message.room, (outgoing) => this.transmit(outgoing));
        state.peer = peer;
        this.options.onPeer(peer);
        return;
      }
      case "frame":
        state?.peer?.deliver(message.data);
        return;
      case "peer_left": {
        if (state === undefined) return;
        const peer = state.peer;
        state.peer = null;
        peer?.end();
        if (state.leaving) this.leave(state);
        return;
      }
      default: {
        const unreachable: never = message;
        throw new Error(`Unhandled relay message ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private refused(state: RoomState, reason: RelayRefusal): void {
    switch (reason) {
      case "occupied":
      case "busy":
        if (!state.warned) this.options.log(`The relay refused a room (${reason}); retrying every ${rejoinMs / 1000} s.`);
        state.warned = true;
        state.rejoin = setTimeout(() => {
          state.rejoin = null;
          if (this.rooms.get(state.room) === state) this.join(state);
        }, rejoinMs);
        return;
      case "rooms":
        this.options.log("The relay refused a room: this bridge holds too many pairings. Run `obnixe-bridge forget` and pair the phones still in use again.");
        return;
      case "version":
        this.options.log("The relay does not support this bridge version; update obnixe-bridge.");
        return;
      default: {
        const unreachable: never = reason;
        throw new Error(`Unhandled relay refusal ${String(unreachable)}`);
      }
    }
  }

  private disconnected(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.socket = null;
    if (this.stable !== null) clearTimeout(this.stable);
    this.stable = null;
    for (const state of [...this.rooms.values()]) {
      this.release(state);
      if (state.leaving) this.rooms.delete(state.room);
    }
    if (this.stopped) return;
    this.announce("down", "Lost the relay connection; reconnecting.");
    const delay = Math.min(maxRetryMs, (this.options.firstRetryMs ?? defaultFirstRetryMs) * 2 ** this.retries) * (0.8 + Math.random() * 0.4);
    this.retries += 1;
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      this.connect();
    }, delay);
  }

  private announce(reachability: Reachability, line: string): void {
    if (this.reachability === reachability) return;
    this.reachability = reachability;
    this.options.log(line);
  }
}
