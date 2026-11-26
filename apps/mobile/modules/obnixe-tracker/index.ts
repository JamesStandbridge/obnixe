import { requireOptionalNativeModule } from "expo";
import type { NativeModule } from "expo";
import type { Fix, Sample, TrackerMarkKind } from "@obnixe/core";
import type { EpochMs } from "@obnixe/schema";

/** `saver` and `critical` are the battery modes of NRG-001: a fix every 5 s, then every 10 s. */
export type TrackerPower = "normal" | "saver" | "critical";

/** Marks the app or the notification asks for; the module writes `start` and `stop` itself. */
export type TrackerControlMark = Exclude<TrackerMarkKind, "start" | "stop">;

export interface TrackerProgressSegment {
  readonly length: number;
  readonly highlighted: boolean;
}

/** A segmented progress bar, `value` counted on the summed segment lengths. */
export interface TrackerNotificationProgress {
  readonly segments: readonly TrackerProgressSegment[];
  readonly value: number;
}

export interface TrackerNotification {
  /** First line, e.g. "Course · 5,24 km". */
  readonly title: string;
  /** Second line, e.g. "Allure 5:23 /km". */
  readonly text: string;
  /** Instant the displayed timer read zero, shown as a running chronometer, the Live Update chip (Android) and the Live Activity (iOS); null hides it. */
  readonly timerBaseAt: EpochMs | null;
  /** The steps of a guided workout as `Notification.ProgressStyle` on Android 16 (`REC-074`); ignored elsewhere. */
  readonly progress: TrackerNotificationProgress | null;
}

/** The GATT services of the Bluetooth sources: heart rate, cycling speed and cadence, cycling power, running speed and cadence. */
export type SensorService = "heart_rate" | "cycling_speed_cadence" | "cycling_power" | "running_speed_cadence";

export interface BluetoothSensor {
  readonly service: SensorService;
  /** As reported by `onSensorDevice`: its Bluetooth address on Android, its Core Bluetooth UUID on iOS. */
  readonly id: string;
}

export interface TrackerSensors {
  readonly barometer: boolean;
  readonly pedometer: boolean;
  /** At most one per measured role; one device may appear under several services. */
  readonly bluetooth: readonly BluetoothSensor[];
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
  /**
   * `onSamples` interval while the screen is on (iOS: the app in the foreground) (PRF-003). The journal is written
   * every 5 s whatever the interval (PRF-051), and at once on a mark or when the screen goes off.
   */
  readonly deliveryIntervalMs: 1000 | 5000;
  /** The same interval while the screen is off (iOS: the app in the background): 5 s, 1 s during a guided workout (WKT-006). */
  readonly backgroundDeliveryIntervalMs: 1000 | 5000;
  readonly notification: TrackerNotification;
  readonly replay: TrackerReplay | null;
}

export type TrackerLocationSource = "fused" | "gps" | "core_location" | "replay";

export interface TrackerSources {
  readonly location: TrackerLocationSource;
  readonly barometer: boolean;
  readonly pedometer: boolean;
  readonly heartRate: boolean;
  readonly cadence: boolean;
  readonly power: boolean;
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

/**
 * Samples of journal batch `sequence` from its `offset`-th on. A batch arrives in parts at the delivery interval while
 * it fills, then a last part with `end` once it is on storage; the parts of a batch follow each other without gap.
 */
export interface SamplePart {
  readonly sessionId: string;
  readonly sequence: number;
  readonly offset: number;
  readonly samples: readonly Sample[];
  readonly end: boolean;
}

/** A mark as written to the journal, whether it came from the app or the notification; it closes batch `sequence`, after its last part. */
export interface TrackerMarkEvent {
  readonly sessionId: string;
  readonly sequence: number;
  readonly kind: TrackerMarkKind;
  readonly t: number;
}

/** `storage_full` means the module stopped the recording itself; `stop()` then returns how it ended. */
export type TrackerIssueKind = "permission_lost" | "provider_disabled" | "storage_low" | "storage_full" | "heart_rate_lost" | "cadence_lost" | "power_lost";

export interface TrackerIssue {
  readonly sessionId: string;
  readonly kind: TrackerIssueKind;
}

export interface SensorDevice {
  readonly service: SensorService;
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

export type TrackerEvents = {
  onSamples: (part: SamplePart) => void;
  onMark: (mark: TrackerMarkEvent) => void;
  onIssue: (issue: TrackerIssue) => void;
  onSensorDevice: (device: SensorDevice) => void;
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
  /** Reports the advertisers of `service` through `onSensorDevice` until the timeout or `stopScan`. */
  scanSensors(service: SensorService, timeoutMs: number): Promise<void>;
  stopScan(): void;
  stop(): Promise<TrackerStopped>;
}

export type TrackerModule = ObnixeTrackerModule;

/** The tracker module, or null where the app was built without it (web). */
export const tracker: ObnixeTrackerModule | null = requireOptionalNativeModule<ObnixeTrackerModule>("ObnixeTracker");
