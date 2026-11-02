import { requireOptionalNativeModule } from "expo";
import type { NativeModule } from "expo";

export type TunnelState = "connecting" | "online" | "reconnecting" | "error" | "stopped";

export interface TunnelStatus {
  readonly state: TunnelState;
  readonly url: string;
  readonly message: string;
}

/** One HTTP request received through the tunnel; `headers` is a JSON object of lowercase names to values. */
export interface TunnelRequest {
  readonly id: number;
  readonly method: string;
  readonly target: string;
  readonly headers: string;
  readonly body: string;
}

type RemoteEvents = {
  onRequest: (request: TunnelRequest) => void;
  onStatus: (status: TunnelStatus) => void;
};

declare class ObnixeRemoteModule extends NativeModule<RemoteEvents> {
  isSupported(): boolean;
  status(): TunnelStatus;
  /** Starts the foreground service publishing the phone on the ngrok dev domain of `authtoken`'s account. */
  start(authtoken: string): void;
  stop(): void;
  /** Answers request `id`; `headers` is a JSON object of names to values. */
  respond(id: number, status: number, headers: string, body: string): void;
}

const native = requireOptionalNativeModule<ObnixeRemoteModule>("ObnixeRemote");

/** The tunnel module, or null where the app was built without it or the device cannot load it. */
export const remoteTunnel: ObnixeRemoteModule | null = native !== null && native.isSupported() ? native : null;
