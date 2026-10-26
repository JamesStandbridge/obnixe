import { Platform } from "react-native";
import { getRandomValues } from "expo-crypto";
import {
  PhoneSession,
  ProtocolError,
  closeConnection,
  generatePairingCode,
  openConnection,
  pairingCodeTtlMs,
  phoneRevocation,
  renameConnectionClient,
  runAgentTool,
} from "@obnixe/core";
import type { PhoneLinkStatus, PhonePairing, PhoneRevocation, RejectionReason } from "@obnixe/core";
import type { ConnectionEndReason, EpochMs, Id } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { bridgeUrl } from "@/features/agent/host";
import { deletePairing, deleteRevocation, readDeviceId, readPairing, readRevocation, savePairing, saveRevocation } from "@/features/agent/trust";
import { deviceTimeZone } from "@/format/dates";

export type NetworkState = "idle" | "dialing" | "reachable" | "unreachable";

export type LinkView =
  | { readonly kind: "pairing"; readonly code: string; readonly expiresAt: number; readonly network: NetworkState }
  | { readonly kind: "resuming"; readonly mac: string; readonly network: NetworkState }
  | { readonly kind: "connected"; readonly connectionId: Id; readonly since: number }
  | { readonly kind: "disconnected"; readonly connectionId: Id; readonly at: EpochMs };

export type LinkNotice = "code_refused" | "version" | "forgotten";

export interface LinkListener {
  readonly onView: (view: LinkView) => void;
  readonly onNotice: (notice: LinkNotice) => void;
  readonly onKnownMac: (mac: string | null) => void;
}

interface PairingCode {
  readonly code: string;
  readonly expiresAt: number;
}

const redialMs = 3000;
const watchMs = 1000;
const firstRetryMs = 1000;
const maxRetryMs = 30_000;

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

function newCode(): PairingCode {
  return { code: generatePairingCode(randomBytes), expiresAt: environment.now() + pairingCodeTtlMs };
}

/**
 * Owns the socket to the bridge for the Agent screen: resumes a trusted Mac without a code, redials it with backoff after
 * drops, otherwise rotates single-use codes while pairing, and ends the connection on demand.
 */
export class AgentLink {
  private readonly listener: LinkListener;
  private readonly deviceId: string;
  private host: string | null;
  private pairing: PhonePairing | null;
  private revocation: PhoneRevocation | null;
  private current: LinkView;
  private spare: PairingCode | null = null;
  private socket: WebSocket | null = null;
  private session: PhoneSession | null = null;
  private redial: ReturnType<typeof setTimeout> | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  private retries = 0;
  private wanted = false;

  constructor(host: string | null, listener: LinkListener) {
    this.host = host;
    this.listener = listener;
    this.deviceId = readDeviceId(randomBytes);
    this.pairing = readPairing();
    this.revocation = readRevocation();
    this.current = this.openingView();
  }

  get view(): LinkView {
    return this.current;
  }

  get knownMac(): string | null {
    return this.pairing?.bridgeName ?? null;
  }

  start(): void {
    this.watch ??= setInterval(() => this.tick(), watchMs);
    this.wanted = true;
    this.retries = 0;
    this.hangUp();
    this.setView(this.openingView());
    this.dial();
  }

  setHost(host: string | null): void {
    if (host === this.host) return;
    this.host = host;
    if (this.current.kind !== "pairing" && this.current.kind !== "resuming") return;
    this.hangUp();
    this.setView({ ...this.current, network: host === null ? "idle" : "dialing" });
    this.dial();
  }

  end(reason: ConnectionEndReason): void {
    this.wanted = false;
    this.closeOpen(reason);
    this.hangUp();
  }

  suspend(): void {
    this.closeOpen("screen_closed");
    this.hangUp();
  }

  resume(): void {
    if (!this.wanted || this.socket !== null || this.redial !== null) return;
    if (this.pairing !== null) {
      this.retries = 0;
      this.setView(this.resumingView(this.pairing, "dialing"));
      this.dial();
      return;
    }
    if (this.current.kind === "pairing") this.dial();
  }

  /** Deletes the trusted Mac, keeps a revocation token for the bridge and goes back to code pairing. */
  forget(): void {
    const pairing = this.pairing;
    if (pairing === null) return;
    const revocation = phoneRevocation(pairing);
    saveRevocation(revocation);
    deletePairing();
    this.revocation = revocation;
    this.pairing = null;
    this.listener.onKnownMac(null);
    this.closeOpen("user");
    this.start();
  }

  dispose(reason: ConnectionEndReason): void {
    this.end(reason);
    if (this.watch !== null) clearInterval(this.watch);
    this.watch = null;
  }

  private openingView(): LinkView {
    if (this.pairing !== null) return this.resumingView(this.pairing, this.host === null ? "idle" : "dialing");
    return this.pairingView(newCode());
  }

  private pairingView(code: PairingCode): Extract<LinkView, { kind: "pairing" }> {
    return { kind: "pairing", code: code.code, expiresAt: code.expiresAt, network: this.host === null ? "idle" : "dialing" };
  }

  private resumingView(pairing: PhonePairing, network: NetworkState): Extract<LinkView, { kind: "resuming" }> {
    return { kind: "resuming", mac: pairing.bridgeName, network };
  }

  private setView(view: LinkView): void {
    this.current = view;
    this.listener.onView(view);
  }

  private setNetwork(network: NetworkState): void {
    const view = this.current;
    if ((view.kind === "pairing" || view.kind === "resuming") && view.network !== network) this.setView({ ...view, network });
  }

  /** Code a dial offers in case the bridge turns out not to be the trusted Mac; it is only shown then. */
  private dialCode(): PairingCode {
    const view = this.current;
    if (view.kind === "pairing") return { code: view.code, expiresAt: view.expiresAt };
    if (this.spare === null || this.spare.expiresAt <= environment.now()) this.spare = newCode();
    return this.spare;
  }

  private closeOpen(reason: ConnectionEndReason): void {
    const session = this.session;
    const connectionId = session?.connectionId ?? null;
    if (connectionId === null || session === null || session.isClosed) return;
    closeConnection(db(), environment, connectionId, reason);
    session.close(reason);
    this.setView({ kind: "disconnected", connectionId, at: environment.now() });
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
    if ((view.kind !== "pairing" && view.kind !== "resuming") || this.host === null) return;
    const socket = new WebSocket(bridgeUrl(this.host));
    const session = new PhoneSession({
      code: this.dialCode().code,
      device: deviceName(),
      deviceId: this.deviceId,
      pairing: this.pairing,
      revocation: this.revocation,
      randomBytes,
      now: environment.now,
      socket: { send: (text) => socket.send(text), close: () => socket.close() },
      handlers: {
        onStatus: (status) => this.onStatus(session, status),
        onOpen: (peer) => openConnection(db(), environment, peer),
        onClient: (connectionId, client) => renameConnectionClient(db(), connectionId, client),
        onCall: (connectionId, tool, args) => runAgentTool(db(), environment, { connectionId, tool, arguments: args, timeZone: deviceTimeZone() }),
        onRejected: (reason) => this.onRejected(reason),
        onPaired: (pairing) => this.onPaired(pairing),
        onRevocationSent: (revocation) => this.onRevocationSent(revocation),
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
        if (this.current.kind === "resuming") {
          this.setView({ ...this.pairingView(this.dialCode()), network: "reachable" });
          this.spare = null;
        }
        return;
      case "waiting":
      case "resuming":
        this.setNetwork("reachable");
        return;
      case "open":
        this.retries = 0;
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

  private onPaired(pairing: PhonePairing): void {
    savePairing(pairing);
    this.pairing = pairing;
    this.spare = null;
    this.listener.onKnownMac(pairing.bridgeName);
  }

  private onRevocationSent(revocation: PhoneRevocation): void {
    if (this.revocation?.pairingId !== revocation.pairingId) return;
    deleteRevocation();
    this.revocation = null;
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
        if (this.current.kind === "resuming") this.retry();
        else this.rotateCode();
        return;
      case "unknown":
      case "revoked":
        // Rejections are not authenticated: the stored pairing is only replaced by a successful code pairing.
        this.pairing = null;
        this.listener.onKnownMac(null);
        this.listener.onNotice("forgotten");
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
      if (this.pairing !== null && this.wanted) this.retry();
      else this.setView({ kind: "disconnected", connectionId, at: environment.now() });
      return;
    }
    if (this.current.kind === "resuming") {
      this.retry();
      return;
    }
    if (this.current.kind !== "pairing") return;
    if (session.codeExposed) {
      this.rotateCode();
      return;
    }
    this.setNetwork("unreachable");
    this.redial = setTimeout(() => {
      this.redial = null;
      this.dial();
    }, redialMs);
  }

  /** Redials the trusted Mac after a drop, waiting 1 s, 2 s, 4 s and so on up to 30 s between attempts. */
  private retry(): void {
    const pairing = this.pairing;
    if (pairing === null) {
      this.rotateCode();
      return;
    }
    this.hangUp();
    const delay = Math.min(maxRetryMs, firstRetryMs * 2 ** this.retries);
    this.retries += 1;
    this.setView(this.resumingView(pairing, this.retries > 1 ? "unreachable" : "dialing"));
    this.redial = setTimeout(() => {
      this.redial = null;
      this.dial();
    }, delay);
  }

  private rotateCode(): void {
    this.hangUp();
    this.setView(this.pairingView(newCode()));
    this.dial();
  }

  private tick(): void {
    const now = environment.now();
    if (this.current.kind === "pairing" && now >= this.current.expiresAt) {
      this.rotateCode();
      return;
    }
    if (this.current.kind !== "connected" || this.session?.isStale(now) !== true) return;
    if (this.pairing === null) {
      this.end("timeout");
      return;
    }
    this.closeOpen("timeout");
    this.retry();
  }
}
