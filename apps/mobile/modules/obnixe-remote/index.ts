import { requireOptionalNativeModule } from "expo";
import type { NativeModule } from "expo";

/** `open` once the WebSocket is up, `waiting` between a lost link and the next attempt. */
export type LinkState = "connecting" | "open" | "waiting" | "stopped";

export interface LinkStatus {
  readonly state: LinkState;
  readonly message: string;
}

/** One text frame received from the relay. */
export interface LinkFrame {
  readonly text: string;
}

type RemoteEvents = {
  onFrame: (frame: LinkFrame) => void;
  onStatus: (status: LinkStatus) => void;
};

declare class ObnixeRemoteModule extends NativeModule<RemoteEvents> {
  status(): LinkStatus;
  /** Starts the foreground service keeping a WebSocket to `url` open until stopped. */
  start(url: string): void;
  stop(): void;
  /** Sends a text frame; false when the link is down. */
  send(text: string): boolean;
}

/** The relay link module, or null where the app was built without it. */
export const relayLink: ObnixeRemoteModule | null = requireOptionalNativeModule<ObnixeRemoteModule>("ObnixeRemote");
