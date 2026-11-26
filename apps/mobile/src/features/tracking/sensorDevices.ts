import { pairedSensorOf, sensorRoles, sensorRolesOf } from "@obnixe/core";
import type { ResolvedProfile, SensorRole } from "@obnixe/core";
import type { RecordingSettings } from "@obnixe/schema";
import type { BluetoothSensor, SensorDevice, SensorService, TrackerIssueKind } from "../../../modules/obnixe-tracker";

export type SignalStrength = "strong" | "medium" | "weak";

export function signalStrengthOf(rssi: number): SignalStrength {
  if (rssi >= -65) return "strong";
  return rssi >= -80 ? "medium" : "weak";
}

/** Keeps one entry per source with its latest signal and a name, strongest first. */
export function withDevice(devices: readonly SensorDevice[], device: SensorDevice): readonly SensorDevice[] {
  const known = devices.find((item) => item.id === device.id);
  const merged: SensorDevice = { ...device, name: device.name.trim() === "" ? (known?.name ?? device.name) : device.name };
  return [...devices.filter((item) => item.id !== device.id), merged].sort((left, right) => right.rssi - left.rssi);
}

export function isSensorRole(value: string | undefined): value is SensorRole {
  return sensorRoles.some((role) => role === value);
}

/** The service a source of `role` advertises: a footpod counts steps (`RSC`), a bike sensor crank revolutions (`CSC`). */
export function sensorServiceOf(role: SensorRole, profile: Pick<ResolvedProfile, "cadence">): SensorService {
  switch (role) {
    case "heart_rate":
      return "heart_rate";
    case "cadence":
      return profile.cadence === "steps" ? "running_speed_cadence" : "cycling_speed_cadence";
    case "power":
      return "cycling_power";
    default: {
      const unreachable: never = role;
      throw new Error(`Unhandled sensor role ${String(unreachable)}`);
    }
  }
}

/** The memorized sources the tracker connects at the start, only those the profile pairs (`SPT-007`, `SPT-008`). */
export function bluetoothSensorsOf(profile: Pick<ResolvedProfile, "sport" | "metrics" | "cadence">, settings: RecordingSettings): readonly BluetoothSensor[] {
  return sensorRolesOf(profile).flatMap((role) => {
    const device = pairedSensorOf(profile, settings, role);
    return device === null ? [] : [{ service: sensorServiceOf(role, profile), id: device.id }];
  });
}

export function sensorLostIssueOf(role: SensorRole): TrackerIssueKind {
  switch (role) {
    case "heart_rate":
      return "heart_rate_lost";
    case "cadence":
      return "cadence_lost";
    case "power":
      return "power_lost";
    default: {
      const unreachable: never = role;
      throw new Error(`Unhandled sensor role ${String(unreachable)}`);
    }
  }
}

export function sensorRoleOfIssue(kind: TrackerIssueKind): SensorRole | null {
  return sensorRoles.find((role) => sensorLostIssueOf(role) === kind) ?? null;
}
