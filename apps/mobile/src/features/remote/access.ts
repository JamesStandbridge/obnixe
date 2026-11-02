import { useSyncExternalStore } from "react";
import { getRandomValues } from "expo-crypto";
import { parseRelayFrame, remoteConnectUrl, remotePhoneOrigin, RemoteServer, signRemoteChallenge } from "@obnixe/core";
import type { PendingAuthorization, PhoneFrame, RemoteGrant, RemoteIdentity, RemoteResponse } from "@obnixe/core";
import { db, environment } from "@/data/database";
import { deviceTimeZone } from "@/format/dates";
import { askApprovalNotifications } from "@/features/remote/notifications";
import { createIdentity, openVault, readEnabled, readGrants, readIdentity, saveEnabled } from "@/features/remote/vault";
import { relayLink } from "../../../modules/obnixe-remote";
import type { LinkFrame, LinkStatus } from "../../../modules/obnixe-remote";

/** `online` once the relay accepted the phone's proof; `waiting` while the link is down and retrying. */
export type RemoteLinkState = "connecting" | "online" | "waiting" | "stopped";

export interface RemoteAccessState {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly link: RemoteLinkState;
  /** The phone's public origin, known from its identity before it ever connects. */
  readonly origin: string | null;
  readonly pending: readonly PendingAuthorization[];
  readonly grants: readonly RemoteGrant[];
}

const internalError: RemoteResponse = { status: 500, headers: { "content-type": "text/plain; charset=utf-8" }, body: "The phone failed to answer" };

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  getRandomValues(bytes);
  return bytes;
}

function linkState(status: LinkStatus): RemoteLinkState {
  switch (status.state) {
    case "connecting":
    case "open":
      return "connecting";
    case "waiting":
      return "waiting";
    case "stopped":
      return "stopped";
    default: {
      const unreachable: never = status.state;
      return unreachable;
    }
  }
}

/**
 * Serves the phone to remote agents: owns the OAuth and MCP server, proves the phone's identity to the relay, answers
 * the requests the relay forwards, and reconnects at launch while remote access is on. Lives as long as the app process.
 */
class RemoteAccess {
  private server: RemoteServer | null = null;
  private identity: RemoteIdentity | null = readIdentity();
  private state: RemoteAccessState = {
    available: relayLink !== null,
    enabled: relayLink !== null && readEnabled(),
    link: relayLink === null ? "stopped" : linkState(relayLink.status()),
    origin: this.identity === null ? null : remotePhoneOrigin(this.identity.id),
    pending: [],
    grants: readGrants(),
  };
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): RemoteAccessState => this.state;

  /** Wires the relay link once the database is open; later calls do nothing. */
  attach(): void {
    const link = relayLink;
    if (link === null || this.server !== null) return;
    const server = new RemoteServer({
      db: db(),
      env: environment,
      vault: openVault(randomBytes),
      randomBytes,
      timeZone: deviceTimeZone,
      listener: {
        onAuthorizations: (pending) => this.update({ pending }),
        onGrants: (grants) => this.update({ grants }),
      },
    });
    server.setBaseUrl(this.state.origin);
    this.server = server;
    link.addListener("onStatus", (status) => this.update({ link: linkState(status) }));
    link.addListener("onFrame", (frame) => this.onFrame(server, frame));
    const identity = this.identity;
    if (this.state.enabled && identity !== null && link.status().state === "stopped") link.start(remoteConnectUrl(identity.publicKey));
  }

  enable(): void {
    const link = relayLink;
    if (link === null) return;
    const identity = this.identity ?? createIdentity(randomBytes);
    this.identity = identity;
    const origin = remotePhoneOrigin(identity.id);
    this.server?.setBaseUrl(origin);
    saveEnabled(true);
    this.update({ enabled: true, origin });
    askApprovalNotifications();
    link.start(remoteConnectUrl(identity.publicKey));
  }

  disable(): void {
    saveEnabled(false);
    this.update({ enabled: false });
    relayLink?.stop();
  }

  decide(id: string, approved: boolean): void {
    this.server?.decide(id, approved);
  }

  revoke(grantId: string): void {
    this.server?.revoke(grantId);
  }

  private update(patch: Partial<RemoteAccessState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private send(frame: PhoneFrame): void {
    relayLink?.send(JSON.stringify(frame));
  }

  private onFrame(server: RemoteServer, { text }: LinkFrame): void {
    const frame = parseRelayFrame(text);
    if (frame === null) return;
    switch (frame.type) {
      case "challenge":
        if (this.identity !== null) this.send({ type: "proof", signature: signRemoteChallenge(this.identity, frame.nonce) });
        return;
      case "online":
        this.update({ link: "online" });
        return;
      case "request": {
        const respond = (answer: RemoteResponse): void => this.send({ type: "response", id: frame.id, ...answer });
        void Promise.resolve()
          .then(() => server.handle({ method: frame.method, target: frame.target, headers: frame.headers, body: frame.body }))
          .then(respond, (error: unknown) => {
            respond(internalError);
            ErrorUtils.getGlobalHandler()(error, false);
          });
        return;
      }
      default: {
        const unreachable: never = frame;
        throw new Error(`Unhandled relay frame ${JSON.stringify(unreachable)}`);
      }
    }
  }
}

export const remoteAccess = new RemoteAccess();

export function useRemoteAccess(): RemoteAccessState {
  return useSyncExternalStore(remoteAccess.subscribe, remoteAccess.snapshot);
}
