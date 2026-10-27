import { Platform } from "react-native";
import { getRandomValues } from "expo-crypto";
import {
  PhoneSession,
  ProtocolError,
  closeConnection,
  defaultRelayUrl,
  generatePairingCode,
  openConnection,
  pairingCodeTtlMs,
  pairingRelayRoom,
  phoneRevocation,
  renameConnectionClient,
  runAgentTool,
} from "@obnixe/core";
import type { LearnedPairing, PairingInvite, PhoneLinkStatus, PhonePairing, PhoneRevocation, PhoneSecret, RejectionReason } from "@obnixe/core";
import type { ConnectionEndReason, EpochMs, Id } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { bridgeUrl } from "@/features/agent/host";
import { dialRelay } from "@/features/agent/relay";
import type { RelayDial } from "@/features/agent/relay";
import { openDirectSocket } from "@/features/agent/socket";
import type { LinkSocket } from "@/features/agent/socket";
import {
  deleteForgottenNotice,
  deletePairing,
  deleteRevocation,
  readDeviceId,
  readForgottenNotice,
  readPairing,
  readRevocation,
  saveForgottenNotice,
  savePairing,
  saveRevocation,
} from "@/features/agent/trust";
import { deviceTimeZone } from "@/format/dates";

export type NetworkState = "idle" | "dialing" | "reachable" | "unreachable";

export type LinkView =
  | { readonly kind: "pairing"; readonly code: string; readonly expiresAt: number; readonly network: NetworkState; readonly host: string | null }
  | { readonly kind: "joining"; readonly mac: string; readonly network: NetworkState; readonly host: string | null }
  | { readonly kind: "resuming"; readonly mac: string; readonly network: NetworkState; readonly host: string | null }
  | { readonly kind: "connected"; readonly connectionId: Id; readonly since: number }
  | { readonly kind: "disconnected"; readonly connectionId: Id; readonly at: EpochMs };

type DialingView = Extract<LinkView, { kind: "pairing" | "joining" | "resuming" }>;

export type LinkNotice = "code_refused" | "version" | "forgotten" | "invite_refused" | "invite_expired";

export interface LinkListener {
  readonly onView: (view: LinkView) => void;
  readonly onNotice: (notice: LinkNotice) => void;
  readonly onKnownMac: (mac: string | null) => void;
}

interface PairingCode {
  readonly code: string;
  readonly expiresAt: number;
}

/** One way to reach the bridge: an address dialed directly, or a relay room the bridge joined. */
type DialTarget = { readonly kind: "direct"; readonly host: string } | { readonly kind: "relay"; readonly relayUrl: string; readonly room: string };

/** Targets tried in order for one dial; `reached` turns true once the transport to the current one is up. */
interface Route {
  readonly targets: readonly DialTarget[];
  index: number;
  reached: boolean;
}

let activeLink: AgentLink | null = null;

const redialMs = 3000;
const watchMs = 1000;
const firstRetryMs = 1000;
const maxRetryMs = 30_000;
const hostTimeoutMs = 2500;
const hostAnswerMs = 8000;

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

function isDialing(view: LinkView): view is DialingView {
  return view.kind === "pairing" || view.kind === "joining" || view.kind === "resuming";
}

function distinct(hosts: readonly (string | null)[]): readonly string[] {
  const found: string[] = [];
  for (const host of hosts) if (host !== null && !found.includes(host)) found.push(host);
  return found;
}

/**
 * Owns the socket to the bridge for the Agent screen: pairs with a scanned QR code, resumes a trusted Mac without a code
 * through the addresses it announced (last good first), redials it with backoff after drops, otherwise rotates
 * single-use codes while pairing by address, and ends the connection on demand.
 */
export class AgentLink {
  private readonly listener: LinkListener;
  private readonly deviceId: string;
  private host: string | null;
  private preferred: string | null = null;
  private pairing: PhonePairing | null;
  private revocation: PhoneRevocation | null;
  private forgottenNotice: string | null;
  private invite: PairingInvite | null = null;
  private current: LinkView;
  private socket: LinkSocket | null = null;
  private relayDial: RelayDial | null = null;
  private session: PhoneSession | null = null;
  private route: Route | null = null;
  private hostTimer: ReturnType<typeof setTimeout> | null = null;
  private answerTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.forgottenNotice = readForgottenNotice();
    this.current = this.openingView();
  }

  get view(): LinkView {
    return this.current;
  }

  get knownMac(): string | null {
    return this.pairing?.bridgeName ?? null;
  }

  get knownBridgeId(): string | null {
    return this.pairing?.bridgeId ?? null;
  }

  /** Only one link drives the socket: activating one disposes any other, such as a second Agent screen. */
  private activate(): void {
    if (activeLink !== null && activeLink !== this) activeLink.dispose("screen_closed");
    activeLink = this;
    this.watch ??= setInterval(() => this.tick(), watchMs);
  }

  start(): void {
    this.activate();
    this.wanted = true;
    this.retries = 0;
    this.invite = null;
    this.hangUp();
    this.setView(this.openingView());
    this.dial();
  }

  /** Pairs with the Mac of a scanned QR code the user confirmed, ending any current connection first; a stale invite changes nothing. */
  join(invite: PairingInvite): void {
    if (invite.expiresAt <= environment.now()) {
      this.listener.onNotice("invite_expired");
      return;
    }
    this.activate();
    this.wanted = true;
    this.retries = 0;
    this.closeOpen("user");
    this.hangUp();
    this.invite = invite;
    this.setView({ kind: "joining", mac: invite.name, network: "dialing", host: invite.hosts[0] ?? null });
    this.dial();
  }

  cancelJoin(): void {
    if (this.invite === null) return;
    this.start();
  }

  /** A host typed by the user is tried first until a dial succeeds, then joins the known addresses. */
  setHost(host: string | null): void {
    if (host === this.host) return;
    this.host = host;
    this.preferred = host;
    if (!isDialing(this.current)) return;
    this.hangUp();
    this.setView({ ...this.current, network: this.candidates().length === 0 ? "idle" : "dialing", host });
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
    if (this.invite !== null && this.current.kind === "joining") {
      this.dial();
      return;
    }
    if (this.pairing !== null) {
      this.retries = 0;
      this.setView(this.resumingView(this.pairing, "dialing"));
      this.dial();
      return;
    }
    if (this.current.kind === "pairing") this.dial();
  }

  /** Deletes the trusted Mac, keeps a revocation token for the bridge and goes back to pairing. */
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
    if (activeLink === this) activeLink = null;
  }

  private openingView(): LinkView {
    if (this.pairing !== null) return this.resumingView(this.pairing, this.candidates().length === 0 ? "idle" : "dialing");
    return this.pairingView(newCode());
  }

  private pairingView(code: PairingCode): Extract<LinkView, { kind: "pairing" }> {
    return { kind: "pairing", code: code.code, expiresAt: code.expiresAt, network: this.host === null ? "idle" : "dialing", host: this.host };
  }

  private resumingView(pairing: PhonePairing, network: NetworkState): Extract<LinkView, { kind: "resuming" }> {
    return { kind: "resuming", mac: pairing.bridgeName, network, host: this.candidates()[0] ?? null };
  }

  private setView(view: LinkView): void {
    this.current = view;
    this.listener.onView(view);
  }

  private setNetwork(network: NetworkState, host?: string): void {
    const view = this.current;
    if (!isDialing(view)) return;
    const nextHost = host ?? view.host;
    if (view.network !== network || view.host !== nextHost) this.setView({ ...view, network, host: nextHost });
  }

  /** Addresses for the next dial: a host typed meanwhile and the QR code's while joining, else the typed one, the last good one and the announced ones. */
  private candidates(): readonly string[] {
    if (this.invite !== null) return distinct([this.preferred, ...this.invite.hosts]);
    if (this.pairing === null) return distinct([this.preferred, this.host]);
    return distinct([this.preferred, this.host, this.pairing.lastHost, ...this.pairing.hosts]);
  }

  /** The relay as a last resort: the invite room while joining, the room of the pairing when resuming; never for a typed code. */
  private relayTarget(): DialTarget | null {
    const invite = this.invite;
    if (invite !== null) return invite.relay === null ? null : { kind: "relay", relayUrl: invite.relay.url, room: invite.relay.room };
    const pairing = this.pairing;
    if (pairing === null) return null;
    const relayUrl = pairing.relay?.url ?? defaultRelayUrl;
    return relayUrl === "" ? null : { kind: "relay", relayUrl, room: pairingRelayRoom(pairing) };
  }

  private targets(): readonly DialTarget[] {
    const direct: DialTarget[] = this.candidates().map((host) => ({ kind: "direct", host }));
    const relay = this.relayTarget();
    return relay === null ? direct : [...direct, relay];
  }

  private dialSecret(): PhoneSecret {
    const invite = this.invite;
    if (invite !== null) return { kind: "token", token: invite.token, bridgeId: invite.bridgeId };
    const view = this.current;
    return { kind: "code", code: view.kind === "pairing" ? view.code : newCode().code };
  }

  private dialedTarget(): DialTarget | null {
    const route = this.route;
    return route === null ? null : (route.targets[route.index] ?? null);
  }

  /** The address the current dial reached directly; a relay route has none to remember. */
  private dialedHost(): string | null {
    const target = this.dialedTarget();
    return target?.kind === "direct" ? target.host : null;
  }

  private storePairing(pairing: PhonePairing): void {
    savePairing(pairing);
    this.pairing = pairing;
  }

  private closeOpen(reason: ConnectionEndReason): void {
    const session = this.session;
    const connectionId = session?.connectionId ?? null;
    if (connectionId === null || session === null || session.isClosed) return;
    closeConnection(db(), environment, connectionId, reason);
    session.close(reason);
    this.setView({ kind: "disconnected", connectionId, at: environment.now() });
  }

  private clearAnswerTimer(): void {
    if (this.answerTimer !== null) clearTimeout(this.answerTimer);
    this.answerTimer = null;
  }

  private dropSocket(): void {
    if (this.hostTimer !== null) clearTimeout(this.hostTimer);
    this.hostTimer = null;
    this.clearAnswerTimer();
    this.relayDial?.cancel();
    this.relayDial = null;
    const socket = this.socket;
    this.socket = null;
    this.session?.markClosed();
    this.session = null;
    if (socket !== null) {
      socket.onmessage = null;
      socket.onclose = null;
      socket.close();
    }
  }

  private hangUp(): void {
    if (this.redial !== null) clearTimeout(this.redial);
    this.redial = null;
    this.route = null;
    this.dropSocket();
  }

  private dial(): void {
    if (!isDialing(this.current)) return;
    const targets = this.targets();
    if (targets.length === 0) return;
    this.route = { targets, index: 0, reached: false };
    this.dialTarget();
  }

  private dialTarget(): void {
    const route = this.route;
    const target = this.dialedTarget();
    if (route === null || target === null) return;
    switch (target.kind) {
      case "direct": {
        const socket = openDirectSocket(bridgeUrl(target.host), () => {
          if (socket === this.socket) route.reached = true;
        });
        this.attach(socket, target.host);
        this.hostTimer = setTimeout(() => {
          this.hostTimer = null;
          if (!route.reached) this.nextHost(socket);
        }, hostTimeoutMs);
        return;
      }
      case "relay":
        this.dialThroughRelay(route, target);
        return;
      default: {
        const unreachable: never = target;
        throw new Error(`Unhandled dial target ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /** Waits for the relay to pair the phone with the bridge of the room, then runs the session over it like a direct socket. */
  private dialThroughRelay(route: Route, target: Extract<DialTarget, { kind: "relay" }>): void {
    const relayDial = dialRelay({ relayUrl: target.relayUrl, room: target.room });
    this.relayDial = relayDial;
    this.setNetwork("dialing", target.relayUrl.replace(/^wss?:\/\//, ""));
    void relayDial.result.then((result) => {
      if (this.relayDial !== relayDial) {
        if (result.kind === "peer") result.socket.close();
        return;
      }
      this.relayDial = null;
      if (result.kind !== "peer") {
        if (this.route === route) this.advance(route);
        return;
      }
      route.reached = true;
      this.attach(result.socket, target.relayUrl.replace(/^wss?:\/\//, ""));
    });
  }

  /** Runs a new phone session over `socket` and gives the bridge `hostAnswerMs` to answer before the next target. */
  private attach(socket: LinkSocket, label: string): void {
    const session = new PhoneSession({
      secret: this.dialSecret(),
      device: deviceName(),
      deviceId: this.deviceId,
      pairing: this.invite === null ? this.pairing : null,
      pairOtherBridges: false,
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
        onHosts: (hosts) => this.onHosts(hosts),
        onRevocationAcknowledged: (revocation) => this.onRevocationAcknowledged(revocation),
      },
    });
    this.socket = socket;
    this.session = session;
    this.setNetwork("dialing", label);
    this.answerTimer = setTimeout(() => {
      this.answerTimer = null;
      this.nextHost(socket);
    }, hostAnswerMs);
    socket.onmessage = (text) => {
      session.receive(text).catch((error: unknown) => this.onSessionFailed(socket, session, error));
    };
    socket.onclose = () => this.onSocketClosed(socket, session);
  }

  /** Moves on to the next target after a timeout or a socket that closed before a session. */
  private nextHost(socket: LinkSocket): void {
    if (socket !== this.socket) return;
    const route = this.route;
    this.dropSocket();
    if (route !== null) this.advance(route);
  }

  /** Dials the next target of `route`, or gives up after the last one. */
  private advance(route: Route): void {
    if (route.index + 1 < route.targets.length) {
      route.index += 1;
      route.reached = false;
      this.dialTarget();
      return;
    }
    this.route = null;
    this.onUnreachable();
  }

  private onUnreachable(): void {
    const view = this.current;
    switch (view.kind) {
      case "resuming":
        this.retry();
        return;
      case "joining":
        if (this.inviteExpired()) {
          this.leaveInvite("invite_expired");
          return;
        }
        this.setNetwork("unreachable");
        this.redial = setTimeout(() => {
          this.redial = null;
          this.dial();
        }, redialMs);
        return;
      case "pairing":
        this.setNetwork("unreachable");
        this.redial = setTimeout(() => {
          this.redial = null;
          this.dial();
        }, redialMs);
        return;
      case "connected":
      case "disconnected":
        return;
      default: {
        const unreachable: never = view;
        throw new Error(`Unhandled view ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private onStatus(session: PhoneSession, status: PhoneLinkStatus): void {
    if (session !== this.session) return;
    switch (status) {
      case "proving":
        return;
      case "waiting":
      case "resuming":
        this.clearAnswerTimer();
        this.setNetwork("reachable");
        return;
      case "open": {
        this.clearAnswerTimer();
        this.retries = 0;
        this.invite = null;
        this.preferred = null;
        const host = this.dialedHost();
        const pairing = this.pairing;
        if (host !== null && pairing !== null && pairing.lastHost !== host) this.storePairing({ ...pairing, lastHost: host });
        if (this.forgottenNotice !== null) {
          this.forgottenNotice = null;
          deleteForgottenNotice();
        }
        if (session.connectionId !== null) this.setView({ kind: "connected", connectionId: session.connectionId, since: environment.now() });
        return;
      }
      case "closed":
        return;
      default: {
        const unreachable: never = status;
        throw new Error(`Unhandled link status ${String(unreachable)}`);
      }
    }
  }

  private onPaired(learned: LearnedPairing): void {
    this.storePairing({ ...learned, lastHost: this.dialedHost(), relay: this.invite?.relay ?? null });
    this.listener.onKnownMac(learned.bridgeName);
  }

  private onHosts(hosts: readonly string[]): void {
    const pairing = this.pairing;
    if (pairing === null || pairing.hosts.join(",") === hosts.join(",")) return;
    this.storePairing({ ...pairing, hosts: [...hosts] });
  }

  private onRevocationAcknowledged(revocation: PhoneRevocation): void {
    if (this.revocation?.pairingId !== revocation.pairingId) return;
    deleteRevocation();
    this.revocation = null;
  }

  /** Ends the connection with a recorded reason; errors other than protocol violations go to the global handler as non-fatal. */
  private onSessionFailed(socket: LinkSocket, session: PhoneSession, error: unknown): void {
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
    const joining = this.current.kind === "joining";
    switch (reason) {
      case "code":
        if (joining) {
          this.leaveInvite("invite_refused");
          return;
        }
        this.listener.onNotice("code_refused");
        this.rotateCode();
        return;
      case "expired":
        if (joining) this.leaveInvite("invite_refused");
        else if (this.current.kind === "resuming") this.retry();
        else this.rotateCode();
        return;
      case "replaced":
        if (joining) {
          this.hangUp();
          this.dial();
        } else if (this.current.kind === "resuming") this.retry();
        else this.rotateCode();
        return;
      case "unknown":
      case "revoked": {
        // Rejections are not authenticated: the stored pairing is only replaced by a successful pairing.
        const refused = this.pairing;
        this.pairing = null;
        this.listener.onKnownMac(null);
        if (refused !== null && refused.pairingId !== this.forgottenNotice) {
          this.forgottenNotice = refused.pairingId;
          saveForgottenNotice(refused.pairingId);
          this.listener.onNotice("forgotten");
        }
        this.rotateCode();
        return;
      }
      case "version":
        this.listener.onNotice("version");
        return;
      default: {
        const unreachable: never = reason;
        throw new Error(`Unhandled rejection ${String(unreachable)}`);
      }
    }
  }

  private inviteExpired(): boolean {
    return this.invite !== null && this.invite.expiresAt <= environment.now();
  }

  private leaveInvite(notice: LinkNotice): void {
    this.listener.onNotice(notice);
    this.start();
  }

  private onSocketClosed(socket: LinkSocket, session: PhoneSession): void {
    if (socket !== this.socket) return;
    const connectionId = session.connectionId;
    if (connectionId === null) {
      if (this.current.kind === "pairing" && session.codeExposed) this.rotateCode();
      else this.nextHost(socket);
      return;
    }
    const wasOpen = !session.isClosed;
    session.markClosed();
    this.dropSocket();
    this.route = null;
    if (wasOpen) closeConnection(db(), environment, connectionId, "network");
    if (this.pairing !== null && this.wanted) this.retry();
    else this.setView({ kind: "disconnected", connectionId, at: environment.now() });
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
    if (this.current.kind === "joining" && this.inviteExpired()) {
      this.leaveInvite("invite_expired");
      return;
    }
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
