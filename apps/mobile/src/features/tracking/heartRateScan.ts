import { useCallback, useEffect, useState } from "react";
import { withDevice } from "@/features/tracking/heartRateDevices";
import { bluetoothGranted, requestBluetooth } from "@/features/tracking/permissions";
import { tracker } from "../../../modules/obnixe-tracker";
import type { HeartRateDevice } from "../../../modules/obnixe-tracker";

export type HeartRateScanStatus = "idle" | "scanning" | "denied" | "unavailable" | "unsupported" | "failed";

export interface HeartRateScan {
  readonly status: HeartRateScanStatus;
  /** Strongest signal first. */
  readonly devices: readonly HeartRateDevice[];
  /** Whether a scan ran to its end. */
  readonly scanned: boolean;
  readonly scan: () => void;
}

function codeOf(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

/**
 * `SPT-007`: lists the Heart Rate service advertisers while it scans. With `ask`, the Bluetooth permission is requested
 * (`PRV-006`, on the press of the pairing screen); without, a scan only runs once it was granted.
 */
export function useHeartRateScan(timeoutMs: number, ask: boolean): HeartRateScan {
  const [status, setStatus] = useState<HeartRateScanStatus>(tracker === null ? "unsupported" : "idle");
  const [devices, setDevices] = useState<readonly HeartRateDevice[]>([]);
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    if (tracker === null) return undefined;
    const subscription = tracker.addListener("onHeartRateDevice", (device) => setDevices((current) => withDevice(current, device)));
    return () => {
      subscription.remove();
      tracker?.stopScan();
    };
  }, []);

  const scan = useCallback(() => {
    if (tracker === null) return;
    const run = async (): Promise<void> => {
      const allowed = ask ? await requestBluetooth() : await bluetoothGranted();
      if (!allowed) {
        setStatus(ask ? "denied" : "idle");
        return;
      }
      setStatus("scanning");
      try {
        await tracker?.scanHeartRate(timeoutMs);
        setStatus("idle");
        setScanned(true);
      } catch (error) {
        const code = codeOf(error);
        setStatus(code === "ERR_TRACKER_BLUETOOTH_UNAVAILABLE" ? "unavailable" : code === "ERR_TRACKER_BLUETOOTH_PERMISSION" ? "denied" : "failed");
      }
    };
    void run();
  }, [ask, timeoutMs]);

  return { status, devices, scanned, scan };
}
