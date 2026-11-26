import { useCallback, useEffect, useState } from "react";
import { withDevice } from "@/features/tracking/sensorDevices";
import { bluetoothGranted, requestBluetooth } from "@/features/tracking/permissions";
import { tracker } from "../../../modules/obnixe-tracker";
import type { SensorDevice, SensorService } from "../../../modules/obnixe-tracker";

export type SensorScanStatus = "idle" | "scanning" | "denied" | "unavailable" | "unsupported" | "failed";

export interface SensorScan {
  readonly status: SensorScanStatus;
  /** Strongest signal first. */
  readonly devices: readonly SensorDevice[];
  /** Whether a scan ran to its end. */
  readonly scanned: boolean;
  readonly scan: () => void;
}

function codeOf(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

/**
 * `SPT-007`, `SPT-008`: lists the advertisers of `service` while it scans. With `ask`, the Bluetooth permission is
 * requested (`PRV-006`, on the press of the pairing screen); without, a scan only runs once it was granted.
 */
export function useSensorScan(service: SensorService, timeoutMs: number, ask: boolean): SensorScan {
  const [status, setStatus] = useState<SensorScanStatus>(tracker === null ? "unsupported" : "idle");
  const [devices, setDevices] = useState<readonly SensorDevice[]>([]);
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    if (tracker === null) return undefined;
    const subscription = tracker.addListener("onSensorDevice", (device: SensorDevice) => {
      if (device.service === service) setDevices((current) => withDevice(current, device));
    });
    return () => {
      subscription.remove();
      tracker?.stopScan();
    };
  }, [service]);

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
        await tracker?.scanSensors(service, timeoutMs);
        setStatus("idle");
        setScanned(true);
      } catch (error) {
        const code = codeOf(error);
        setStatus(code === "ERR_TRACKER_BLUETOOTH_UNAVAILABLE" ? "unavailable" : code === "ERR_TRACKER_BLUETOOTH_PERMISSION" ? "denied" : "failed");
      }
    };
    void run();
  }, [ask, service, timeoutMs]);

  return { status, devices, scanned, scan };
}
