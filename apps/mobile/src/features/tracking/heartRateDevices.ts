import type { HeartRateDevice } from "../../../modules/obnixe-tracker";

export type SignalStrength = "strong" | "medium" | "weak";

export function signalStrengthOf(rssi: number): SignalStrength {
  if (rssi >= -65) return "strong";
  return rssi >= -80 ? "medium" : "weak";
}

/** Keeps one entry per source with its latest signal and a name, strongest first. */
export function withDevice(devices: readonly HeartRateDevice[], device: HeartRateDevice): readonly HeartRateDevice[] {
  const known = devices.find((item) => item.id === device.id);
  const merged: HeartRateDevice = { ...device, name: device.name.trim() === "" ? (known?.name ?? device.name) : device.name };
  return [...devices.filter((item) => item.id !== device.id), merged].sort((left, right) => right.rssi - left.rssi);
}
