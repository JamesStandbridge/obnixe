import { requireOptionalNativeModule } from "expo";
import type { NativeModule } from "expo";
import type { Fix, Sample, TrackerMarkKind } from "@obnixe/core";
import type { EpochMs } from "@obnixe/schema";

/** `saver` and `critical` are the battery modes of NRG-001: a fix every 5 s, then every 10 s. */
export type TrackerPower = "normal" | "saver" | "critical";

/** Marks the app or the notification asks for; the module writes `start` and `stop` itself. */
export type TrackerControlMark = Exclude<TrackerMarkKind, "start" | "stop">;

export interface TrackerNotification {
  /** First line, e.g. "Course · 5,24 km". */
  readonly title: string;
  /** Second line, e.g. "Allure 5:23 /km". */
  readonly text: string;
  /** Instant the displayed timer read zero, shown as a running chronometer, the Live Update chip (Android) and the Live Activity (iOS); null hides it. */
  readonly timerBaseAt: EpochMs | null;
}

export interface TrackerSensors {
  readonly barometer: boolean;
  readonly pedometer: boolean;
  /** Identifier of the heart rate source, as reported by `onHeartRateDevice`: its Bluetooth address on Android, its Core Bluetooth UUID on iOS. */
  readonly heartRateDevice: string | null;
}

/** Development source (DEC-08): replays a GPX file as simulated fixes, `speed` times faster (1 to 50). */
export interface TrackerReplay {
  readonly gpxPath: string;
  readonly speed: number;
}

export interface TrackerStartRequest {
  /** UUID of the session; the journal header carries it. */
  readonly sessionId: string;
  readonly journalPath: string;
  /**
   * `continue` appends to the journal of an interrupted session (REC-081) or of one resumed from its stop summary,
   * instead of creating a new one: a stop mark at its last record, unless it ends with one, then a start mark now.
   */
  readonly journal: "create" | "continue";
  readonly power: TrackerPower;
  readonly sensors: TrackerSensors;
  /** Journal batch and `onSamples` interval while the screen is on (iOS: the app in the foreground); 5 s otherwise (PRF-003, PRF-051). */
  readonly batchIntervalMs: 1000 | 5000;
  readonly notification: TrackerNotification;
  readonly replay: TrackerReplay | null;
}

export type TrackerLocationSource = "fused" | "gps" | "core_location" | "replay";

export interface TrackerSources {
  readonly location: TrackerLocationSource;
  readonly barometer: boolean;
  readonly pedometer: boolean;
  readonly heartRate: boolean;
}

export interface TrackerStarted {
  /** `t0` of the journal: the instant `t = 0`. */
  readonly startedAt: EpochMs;
  readonly sources: TrackerSources;
}

export interface TrackerStopped {
  readonly sessionId: string;
  readonly endedAt: EpochMs;
  /** Sequence of the batch holding the stop mark. */
  readonly lastSequence: number;
}

export interface TrackerStatus {
  readonly state: "idle" | "preparing" | "recording";
  readonly sessionId: string | null;
}

/** Samples of one journal batch, emitted once the batch is on storage; `sequence` is the batch's journal sequence. */
export interface SampleBatch {
  readonly sessionId: string;
  readonly sequence: number;
  readonly samples: readonly Sample[];
}

/** A mark as written to the journal, whether it came from the app or the notification; it closes batch `sequence`. */
export interface TrackerMarkEvent {
  readonly sessionId: string;
  readonly sequence: number;
  readonly kind: TrackerMarkKind;
  readonly t: number;
}

/** `storage_full` means the module stopped the recording itself; `stop()` then returns how it ended. */
export type TrackerIssueKind = "permission_lost" | "provider_disabled" | "storage_low" | "storage_full" | "heart_rate_lost";

export interface TrackerIssue {
  readonly sessionId: string;
  readonly kind: TrackerIssueKind;
}

export interface HeartRateDevice {
  readonly id: string;
  readonly name: string;
  readonly rssi: number;
}

/** On iOS, `activity` is Motion & Fitness (barometer and pedometer) and `notifications` the Live Activities switch, which only the system settings change. */
export type TrackerPermission = "location" | "activity" | "bluetooth" | "notifications";

/** `approximate` only applies to location, which the tracker needs precise (PRV-003). */
export type PermissionGrant = "granted" | "approximate" | "denied" | "undetermined";

export interface TrackerPermissionStatus {
  readonly grant: PermissionGrant;
  /** False once the system no longer shows the prompt: only the system settings can grant it. */
  readonly canAskAgain: boolean;
}

export type TrackerErrorCode =
  | "ERR_TRACKER_RUNNING"
  | "ERR_TRACKER_NOT_RECORDING"
  | "ERR_TRACKER_LOCATION_PERMISSION"
  | "ERR_TRACKER_BLUETOOTH_PERMISSION"
  | "ERR_TRACKER_BLUETOOTH_UNAVAILABLE"
  | "ERR_TRACKER_INVALID_REQUEST"
  | "ERR_TRACKER_JOURNAL"
  | "ERR_TRACKER_FOREGROUND_START";

type TrackerEvents = {
  onSamples: (batch: SampleBatch) => void;
  onMark: (mark: TrackerMarkEvent) => void;
  onIssue: (issue: TrackerIssue) => void;
  onHeartRateDevice: (device: HeartRateDevice) => void;
  /** Fixes received while preparing; `t` counts from the call to `prepare`. */
  onWarmupFix: (fix: Fix) => void;
};

declare class ObnixeTrackerModule extends NativeModule<TrackerEvents> {
  status(): TrackerStatus;
  getPermission(permission: TrackerPermission): Promise<TrackerPermissionStatus>;
  requestPermission(permission: TrackerPermission): Promise<TrackerPermissionStatus>;
  /** Warms the receiver up while the preparation screen is visible (REC-012); stops when the app leaves the foreground. */
  prepare(): Promise<void>;
  cancelPreparation(): void;
  /** Must be called while the app is visible; writes the start mark at `t = 0` of a created journal. */
  start(request: TrackerStartRequest): Promise<TrackerStarted>;
  /** Written to the journal, then echoed by `onMark`; ignored when the pause state makes it meaningless. */
  mark(kind: TrackerControlMark): void;
  setPower(power: TrackerPower): void;
  setNotification(notification: TrackerNotification): void;
  /** Reports Heart Rate service advertisers through `onHeartRateDevice` until the timeout or `stopScan`. */
  scanHeartRate(timeoutMs: number): Promise<void>;
  stopScan(): void;
  stop(): Promise<TrackerStopped>;
}

/** The tracker module, or null where the app was built without it (web). */
export const tracker: ObnixeTrackerModule | null = requireOptionalNativeModule<ObnixeTrackerModule>("ObnixeTracker");
