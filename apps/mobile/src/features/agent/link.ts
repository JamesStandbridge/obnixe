import { Platform } from "react-native";
import { getRandomValues } from "expo-crypto";
import { PhoneSession, ProtocolError, closeConnection, generatePairingCode, openConnection, pairingCodeTtlMs, renameConnectionClient, runAgentTool } from "@obnixe/core";
import type { PhoneLinkStatus, RejectionReason } from "@obnixe/core";
import type { ConnectionEndReason, Id } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { bridgeUrl } from "@/features/agent/host";

export type NetworkState = "idle" | "dialing" | "reachable" | "unreachable";

export type LinkView =
  | { readonly kind: "pairing"; readonly code: string; readonly expiresAt: number; readonly network: NetworkState }
  | { readonly kind: "connected"; readonly connectionId: Id; readonly since: number }
  | { readonly kind: "disconnected"; readonly connectionId: Id; readonly at: number };

export type LinkNotice = "code_refused" | "version";

export interface LinkListener {
  readonly onView: (view: LinkView) => void;
  readonly onNotice: (notice: LinkNotice) => void;
}

const redialMs = 3000;
const watchMs = 1000;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  getRandomValues(bytes);
  return bytes;
}

function deviceName(): string {
  const os = Platform.OS;
  switch (os) {
    case "ios":
      return "iPhone";
    case "android":
      return "Android";
    case "web":
      return "Navigateur";
    case "macos":
    case "windows":
      return "Téléphone";
    default: {
      const unreachable: never = os;
      return String(unreachable);
    }
  }
}

function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Owns the socket to the bridge for the Agent screen: rotates single-use codes, redials while pairing and ends the connection on demand. */
export class AgentLink {
  private readonly listener: LinkListener;
  private host: string | null;
  private current: LinkView;
  private socket: WebSocket | null = null;
  private session: PhoneSession | null = null;
  private redial: ReturnType<typeof setTimeout> | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;

  constructor(host: string | null, listener: LinkListener) {
    this.host = host;
    this.listener = listener;
    this.current = this.freshPairing();
  }

  get view(): LinkView {
    return this.current;
  }

  start(): void {
    this.watch ??= setInterval(() => this.tick(), watchMs);
    this.setView(this.freshPairing());
    this.dial();
  }

  setHost(host: string | null): void {
    if (host === this.host) return;
    this.host = host;
    if (this.current.kind !== "pairing") return;
    this.hangUp();
    this.setView({ ...this.current, network: host === null ? "idle" : "dialing" });
    this.dial();
  }

  end(reason: ConnectionEndReason): void {
    const session = this.session;
    const connectionId = session?.connectionId ?? null;
    if (connectionId !== null && session !== null && !session.isClosed) {
      closeConnection(db(), environment, connectionId, reason);
      session.close(reason);
      this.setView({ kind: "disconnected", connectionId, at: environment.now() });
    }
    this.hangUp();
  }

  suspend(): void {
    if (this.current.kind === "connected") this.end("screen_closed");
    else this.hangUp();
  }

  resume(): void {
    if (this.current.kind === "pairing" && this.socket === null && this.redial === null) this.dial();
  }

  dispose(reason: ConnectionEndReason): void {
    this.end(reason);
    if (this.watch !== null) clearInterval(this.watch);
    this.watch = null;
  }

  private freshPairing(): LinkView {
    return { kind: "pairing", code: generatePairingCode(randomBytes), expiresAt: environment.now() + pairingCodeTtlMs, network: this.host === null ? "idle" : "dialing" };
  }

  private setView(view: LinkView): void {
    this.current = view;
    this.listener.onView(view);
  }

  private setNetwork(network: NetworkState): void {
    if (this.current.kind === "pairing" && this.current.network !== network) this.setView({ ...this.current, network });
  }

  private hangUp(): void {
    if (this.redial !== null) clearTimeout(this.redial);
    this.redial = null;
    const socket = this.socket;
    this.socket = null;
    this.session?.markClosed();
    this.session = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  }

  private dial(): void {
    const view = this.current;
    if (view.kind !== "pairing" || this.host === null) return;
    const socket = new WebSocket(bridgeUrl(this.host));
    const session = new PhoneSession({
      code: view.code,
      device: deviceName(),
      randomBytes,
      now: environment.now,
      socket: { send: (text) => socket.send(text), close: () => socket.close() },
      handlers: {
        onStatus: (status) => this.onStatus(session, status),
        onOpen: (peer) => openConnection(db(), environment, peer),
        onClient: (connectionId, client) => renameConnectionClient(db(), connectionId, client),
        onCall: (connectionId, tool, args) => runAgentTool(db(), environment, { connectionId, tool, arguments: args, timeZone: deviceTimeZone() }),
        onRejected: (reason) => this.onRejected(reason),
      },
    });
    this.socket = socket;
    this.session = session;
    this.setNetwork("dialing");
    socket.onmessage = (event: MessageEvent) => {
      session.receive(String(event.data)).catch((error: unknown) => this.onSessionFailed(socket, session, error));
    };
    socket.onclose = () => this.onSocketClosed(socket, session);
  }

  private onStatus(session: PhoneSession, status: PhoneLinkStatus): void {
    if (session !== this.session) return;
    switch (status) {
      case "proving":
        return;
      case "waiting":
        this.setNetwork("reachable");
        return;
      case "open":
        if (session.connectionId !== null) this.setView({ kind: "connected", connectionId: session.connectionId, since: environment.now() });
        return;
      case "closed":
        return;
      default: {
        const unreachable: never = status;
        throw new Error(`Unhandled link status ${String(unreachable)}`);
      }
    }
  }

  /** Ends the connection with a recorded reason; errors other than protocol violations go to the global handler as non-fatal. */
  private onSessionFailed(socket: WebSocket, session: PhoneSession, error: unknown): void {
    const reason: ConnectionEndReason = error instanceof ProtocolError ? "protocol" : "error";
    const connectionId = session.connectionId;
    if (socket === this.socket && connectionId !== null) {
      closeConnection(db(), environment, connectionId, reason);
      session.close(reason);
      this.setView({ kind: "disconnected", connectionId, at: environment.now() });
      this.hangUp();
    } else {
      socket.close();
    }
    if (!(error instanceof ProtocolError)) ErrorUtils.getGlobalHandler()(error, false);
  }

  private onRejected(reason: RejectionReason): void {
    switch (reason) {
      case "code":
        this.listener.onNotice("code_refused");
        this.rotateCode();
        return;
      case "expired":
      case "replaced":
        this.rotateCode();
        return;
      case "version":
        this.listener.onNotice("version");
        return;
      default: {
        const unreachable: never = reason;
        throw new Error(`Unhandled rejection ${String(unreachable)}`);
      }
    }
  }

  private onSocketClosed(socket: WebSocket, session: PhoneSession): void {
    if (socket !== this.socket) return;
    const connectionId = session.connectionId;
    const wasOpen = !session.isClosed;
    session.markClosed();
    this.socket = null;
    this.session = null;
    if (connectionId !== null) {
      if (wasOpen) closeConnection(db(), environment, connectionId, "network");
      this.setView({ kind: "disconnected", connectionId, at: environment.now() });
      return;
    }
    if (this.current.kind !== "pairing") return;
    this.setNetwork("unreachable");
    this.redial = setTimeout(() => {
      this.redial = null;
      this.dial();
    }, redialMs);
  }

  private rotateCode(): void {
    this.hangUp();
    this.setView(this.freshPairing());
    this.dial();
  }

  private tick(): void {
    const now = environment.now();
    if (this.current.kind === "pairing" && now >= this.current.expiresAt) {
      this.rotateCode();
      return;
    }
    if (this.current.kind === "connected" && this.session?.isStale(now) === true) this.end("timeout");
  }
}
