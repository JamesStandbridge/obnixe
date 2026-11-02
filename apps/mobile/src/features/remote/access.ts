import { useSyncExternalStore } from "react";
import { getRandomValues } from "expo-crypto";
import { RemoteServer } from "@obnixe/core";
import type { PendingAuthorization, RemoteGrant, RemoteRequest, RemoteResponse } from "@obnixe/core";
import { z } from "zod";
import { db, environment } from "@/data/database";
import { deviceTimeZone } from "@/format/dates";
import { askApprovalNotifications } from "@/features/remote/notifications";
import { deleteAuthtoken, openVault, readAuthtoken, readEnabled, readGrants, saveAuthtoken, saveEnabled } from "@/features/remote/vault";
import { remoteTunnel } from "../../../modules/obnixe-remote";
import type { TunnelRequest, TunnelStatus } from "../../../modules/obnixe-remote";

export interface RemoteAccessState {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly hasAuthtoken: boolean;
  readonly tunnel: TunnelStatus;
  readonly pending: readonly PendingAuthorization[];
  readonly grants: readonly RemoteGrant[];
}

const headersSchema = z.record(z.string(), z.string());
const stopped: TunnelStatus = { state: "stopped", url: "", message: "" };
const internalError: RemoteResponse = { status: 500, headers: { "content-type": "text/plain; charset=utf-8" }, body: "The phone failed to answer" };

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  getRandomValues(bytes);
  return bytes;
}

function parseHeaders(text: string): Readonly<Record<string, string>> {
  const parsed = headersSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : {};
}

/**
 * Serves the phone to remote agents: owns the OAuth and MCP server, answers the requests the native tunnel forwards,
 * and starts the tunnel at launch while remote access is on. Lives as long as the app process.
 */
class RemoteAccess {
  private server: RemoteServer | null = null;
  private state: RemoteAccessState = {
    available: remoteTunnel !== null,
    enabled: remoteTunnel !== null && readEnabled(),
    hasAuthtoken: readAuthtoken() !== null,
    tunnel: remoteTunnel?.status() ?? stopped,
    pending: [],
    grants: readGrants(),
  };
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): RemoteAccessState => this.state;

  /** Wires the native tunnel once the database is open; later calls do nothing. */
  attach(): void {
    const tunnel = remoteTunnel;
    if (tunnel === null || this.server !== null) return;
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
    this.server = server;
    tunnel.addListener("onStatus", (status) => this.onStatus(status));
    tunnel.addListener("onRequest", (request) => this.onRequest(server, request));
    this.onStatus(tunnel.status());
    const authtoken = readAuthtoken();
    if (this.state.enabled && authtoken !== null && this.state.tunnel.state === "stopped") tunnel.start(authtoken);
  }

  enable(authtoken: string): void {
    const tunnel = remoteTunnel;
    if (tunnel === null) return;
    saveAuthtoken(authtoken);
    saveEnabled(true);
    this.update({ enabled: true, hasAuthtoken: true });
    askApprovalNotifications();
    tunnel.start(authtoken);
  }

  /** Turns remote access back on with the stored ngrok token. */
  resume(): void {
    const authtoken = readAuthtoken();
    if (authtoken !== null) this.enable(authtoken);
  }

  disable(): void {
    saveEnabled(false);
    this.update({ enabled: false });
    remoteTunnel?.stop();
  }

  /** Turns remote access off and drops the ngrok token, so another account can be used. */
  forgetAuthtoken(): void {
    this.disable();
    deleteAuthtoken();
    this.update({ hasAuthtoken: false });
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

  private onStatus(status: TunnelStatus): void {
    if (status.url !== "") this.server?.setBaseUrl(status.url);
    this.update({ tunnel: status });
  }

  /** Always answers the tunnel, even when the server throws; the error then reaches the global handler as non-fatal. */
  private onRequest(server: RemoteServer, request: TunnelRequest): void {
    const respond = (answer: RemoteResponse): void => remoteTunnel?.respond(request.id, answer.status, JSON.stringify(answer.headers), answer.body);
    void Promise.resolve()
      .then(() => server.handle({ method: request.method, target: request.target, headers: parseHeaders(request.headers), body: request.body } satisfies RemoteRequest))
      .then(respond, (error: unknown) => {
        respond(internalError);
        ErrorUtils.getGlobalHandler()(error, false);
      });
  }
}

export const remoteAccess = new RemoteAccess();

export function useRemoteAccess(): RemoteAccessState {
  return useSyncExternalStore(remoteAccess.subscribe, remoteAccess.snapshot);
}
