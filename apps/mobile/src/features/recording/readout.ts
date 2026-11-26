import type { ResolvedProfile } from "@obnixe/core";
import type { MetricKey, Readout, RecordingSettings } from "@obnixe/schema";

export const secondaryLimits = { min: 3, max: 5 } as const;

export type ReadoutSlot = { readonly kind: "main" } | { readonly kind: "secondary"; readonly index: number };

/** The profile's metrics that have a live value: the energy is estimated after the activity only. */
export function liveMetricsOf(profile: Pick<ResolvedProfile, "metrics">): readonly MetricKey[] {
  return profile.metrics.filter((key) => key !== "energy");
}

/**
 * `SPT-005`: the sport's chosen readout, else annex A where a memorized heart-rate source takes the last secondary place.
 * Metrics the profile of the chosen option does not compute are left out (`SPT-004`). A guided workout takes the main place
 * with `workout_step` (`WKT-004`).
 */
export function liveReadout(profile: Pick<ResolvedProfile, "metrics" | "readout">, settings: Pick<RecordingSettings, "readout" | "heartRateDevice">, guided: boolean): Readout {
  const available = new Set(liveMetricsOf(profile));
  const chosen = settings.readout;
  const base = chosen ?? withHeartRate(profile.readout, settings.heartRateDevice !== null && available.has("heart_rate"));
  const main = guided ? "workout_step" : available.has(base.main) ? base.main : profile.readout.main;
  return { main, secondary: base.secondary.filter((key) => key !== main && available.has(key)) };
}

function withHeartRate(readout: Readout, heartRate: boolean): Readout {
  if (!heartRate || readout.main === "heart_rate" || readout.secondary.includes("heart_rate")) return readout;
  return { main: readout.main, secondary: [...readout.secondary.slice(0, -1), "heart_rate"] };
}

export function metricAt(readout: Readout, slot: ReadoutSlot): MetricKey | undefined {
  return slot.kind === "main" ? readout.main : readout.secondary[slot.index];
}

/** Puts `key` at `slot`; a metric already shown elsewhere swaps places with the replaced one. */
export function withMetric(readout: Readout, slot: ReadoutSlot, key: MetricKey): Readout {
  const replaced = metricAt(readout, slot);
  if (replaced === undefined || replaced === key) return readout;
  const swap = (current: MetricKey): MetricKey => (current === key ? replaced : current);
  if (slot.kind === "main") return { main: key, secondary: readout.secondary.map(swap) };
  return { main: swap(readout.main), secondary: readout.secondary.map((current, index) => (index === slot.index ? key : swap(current))) };
}

/** Adds a secondary metric at the end; null when the screen is full or the metric is already shown. */
export function withSecondaryAdded(readout: Readout, key: MetricKey): Readout | null {
  if (readout.secondary.length >= secondaryLimits.max || readout.main === key || readout.secondary.includes(key)) return null;
  return { main: readout.main, secondary: [...readout.secondary, key] };
}

/** Removes a secondary metric; null when the screen would keep fewer than three. */
export function withSecondaryRemoved(readout: Readout, index: number): Readout | null {
  if (readout.secondary.length <= secondaryLimits.min || index < 0 || index >= readout.secondary.length) return null;
  return { main: readout.main, secondary: readout.secondary.filter((_, position) => position !== index) };
}

export function sameReadout(left: Readout, right: Readout): boolean {
  return left.main === right.main && left.secondary.length === right.secondary.length && left.secondary.every((key, index) => right.secondary[index] === key);
}

/** The value to store: the default readout is stored as none, so a change of annex A reaches it. */
export function storedReadout(profile: Pick<ResolvedProfile, "metrics" | "readout">, settings: Pick<RecordingSettings, "heartRateDevice">, readout: Readout): Readout | null {
  return sameReadout(readout, liveReadout(profile, { readout: null, heartRateDevice: settings.heartRateDevice }, false)) ? null : readout;
}
