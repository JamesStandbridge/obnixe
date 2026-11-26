import type { RecordingProfile, SportKey } from "@obnixe/schema";
import type { ResolvedProfile } from "./profile.ts";
import { absentValue } from "./types.ts";
import type { PowerColumns, SampleColumns } from "./types.ts";
import type { TimeSpan } from "./zones.ts";

/** What a paired Bluetooth source measures (`SPT-007`, `SPT-008`). */
export const sensorRoles = ["heart_rate", "cadence", "power"] as const;
export type SensorRole = (typeof sensorRoles)[number];

/** Sports whose power a Cycling Power source measures: crank, pedal or hub meters on the bike, running pods on foot (`SPT-008`). */
const powerSports: ReadonlySet<SportKey> = new Set<SportKey>(["bike", "run", "trail"]);

/** The sources a profile pairs: the heart rate and the cadence where it shows them, the power on the `powerSports`. */
export function sensorRolesOf(profile: Pick<ResolvedProfile, "sport" | "metrics">): readonly SensorRole[] {
  return sensorRoles.filter((role) => {
    switch (role) {
      case "heart_rate":
      case "cadence":
        return profile.metrics.includes(role);
      case "power":
        return powerSports.has(profile.sport);
      default: {
        const unhandled: never = role;
        throw new Error(`Unhandled sensor role ${String(unhandled)}`);
      }
    }
  });
}

/** A Bluetooth reading holds until the next one, at most this long: a dropout is never filled with an invented value (`SPT-008`). */
export const sensorHoldMs = 5000;
/** Share of the moving time a cadence or power source must cover for its average, as for the heart rate (`SPT-003`). */
export const sensorAverageCoverage = 0.5;

/** One value per instant, ordered by `t`; `absentValue` is not a reading and ends the previous hold. */
export interface SensorReadings {
  readonly length: number;
  readonly t: Uint32Array;
  readonly value: ArrayLike<number>;
}

export function powerReadings(power: PowerColumns): SensorReadings {
  return { length: power.length, t: power.t, value: power.watts };
}

/**
 * The cadence of the activity in the unit of the sport's `cadence` metric: the cadence sensor, otherwise the crank data of the
 * power meter; `null` without either, the pedometer then measures it (`SPT-008`).
 */
export function cadenceReadings(samples: Pick<SampleColumns, "cadence" | "power">): SensorReadings | null {
  const { cadence, power } = samples;
  if (cadence.length > 0) return { length: cadence.length, t: cadence.t, value: cadence.perMinute };
  for (let index = 0; index < power.length; index += 1) {
    if (power.cadence[index] !== absentValue) return { length: power.length, t: power.t, value: power.cadence };
  }
  return null;
}

/**
 * Visits every interval during which a reading holds, clipped to `window`, in time order: from each reading to the next one, at
 * most `sensorHoldMs`.
 */
export function forEachSensorSpan(readings: SensorReadings, window: TimeSpan, visit: (startMs: number, endMs: number, value: number) => void): void {
  const { length, t, value } = readings;
  for (let index = 0; index < length; index += 1) {
    const reading = value[index] ?? absentValue;
    if (reading === absentValue) continue;
    const at = t[index] ?? 0;
    const next = index + 1 < length ? (t[index + 1] ?? at) : Number.POSITIVE_INFINITY;
    const startMs = Math.max(at, window.startMs);
    const endMs = Math.min(next, at + sensorHoldMs, window.endMs);
    if (endMs > startMs) visit(startMs, endMs, reading);
  }
}

/** The reading holding at increasing times, `null` during a dropout. */
export function sensorReader(readings: SensorReadings): (t: number) => number | null {
  let index = -1;
  return (t: number): number | null => {
    while (index + 1 < readings.length && (readings.t[index + 1] ?? 0) <= t) index += 1;
    if (index < 0) return null;
    const reading = readings.value[index] ?? absentValue;
    return reading !== absentValue && t - (readings.t[index] ?? 0) < sensorHoldMs ? reading : null;
  };
}

/** Highest reading in `[startMs, endMs)`. */
export function sensorMaxBetween(readings: SensorReadings, startMs: number, endMs: number): number | null {
  const { t, value, length } = readings;
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((t[middle] ?? 0) < startMs) low = middle + 1;
    else high = middle;
  }
  let max: number | null = null;
  for (let index = low; index < length && (t[index] ?? 0) < endMs; index += 1) {
    const reading = value[index] ?? absentValue;
    if (reading !== absentValue && (max === null || reading > max)) max = reading;
  }
  return max;
}

/** Which readings enter the mean: a power of zero does, a cadence of zero while coasting does not. */
export type SensorAveraging = "every" | "positive";

export function isAveraged(value: number, averaging: SensorAveraging): boolean {
  switch (averaging) {
    case "every":
      return true;
    case "positive":
      return value > 0;
    default: {
      const unhandled: never = averaging;
      throw new Error(`Unhandled averaging ${String(unhandled)}`);
    }
  }
}

/** The mean of the readings over the time they hold inside `window`, `null` without any. */
export function sensorMeanOver(readings: SensorReadings, window: TimeSpan, averaging: SensorAveraging): number | null {
  let integral = 0;
  let averagedMs = 0;
  forEachSensorSpan(readings, window, (startMs, endMs, value) => {
    if (!isAveraged(value, averaging)) return;
    integral += value * (endMs - startMs);
    averagedMs += endMs - startMs;
  });
  return averagedMs === 0 ? null : Math.round(integral / averagedMs);
}

/** The mean over the averaged time, `null` when the readings cover less than `sensorAverageCoverage` of `movingMs`. */
export function sensorAverage(integral: number, averagedMs: number, coveredMs: number, movingMs: number): number | null {
  return averagedMs > 0 && coveredMs >= sensorAverageCoverage * movingMs ? Math.round(integral / averagedMs) : null;
}

/** Cadence sensors measure steps per minute on foot and pedal revolutions per minute otherwise (`cadence` metric). */
export function cadenceStepsPerCycle(cadence: RecordingProfile["cadence"]): number {
  return cadence === "steps" ? 2 : 1;
}
