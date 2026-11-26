import type { EpochMs, Settings } from "@obnixe/schema";
import type { HeartRateColumns } from "./types.ts";

/** Half-open interval `[startMs, endMs)` on the time base of the samples. */
export interface TimeSpan {
  readonly startMs: number;
  readonly endMs: number;
}

/** Readings outside these bounds (0 is written when the sensor reports no skin contact) are not heart rates. */
export const heartRateReadingBounds = { minBpm: 30, maxBpm: 240 } as const;
/** A reading holds until the next one, at most this long: a dropout is never filled with an invented value. */
export const heartRateHoldMs = 5000;

export type HeartRateZone = 1 | 2 | 3 | 4 | 5;

export const heartRateZoneKeys: readonly HeartRateZone[] = [1, 2, 3, 4, 5];

export interface HeartRateZoneBounds {
  readonly zone: HeartRateZone;
  readonly minBpm: number;
  /** Exclusive, except for zone 5 which also holds every rate above the maximum. */
  readonly maxBpm: number;
}

export interface TimeInZones {
  /** Time with a heart-rate reading inside the requested spans. */
  readonly coveredMs: number;
  /** Covered time under 50 % of the maximum. */
  readonly belowMs: number;
  readonly byZone: Readonly<Record<HeartRateZone, number>>;
}

export type PhysiologyProfile = Pick<Settings, "birthYear" | "sex" | "maxHeartRate">;

export function isHeartRateReading(bpm: number): boolean {
  return bpm >= heartRateReadingBounds.minBpm && bpm <= heartRateReadingBounds.maxBpm;
}

/** Age in the calendar year of `at`, which is all the Keytel and Tanaka equations need. */
export function ageAt(birthYear: number, at: EpochMs): number {
  return new Date(at).getUTCFullYear() - birthYear;
}

/** Tanaka et al. (2001), `208 - 0.7 age`: the value the settings prefill (`CAL-004`). */
export function tanakaMaxHeartRate(age: number): number {
  return Math.round(208 - 0.7 * age);
}

/** The maximum set by the user, otherwise the Tanaka estimate from the birth year; `null` without either (`CAL-004`). */
export function maxHeartRateOf(profile: PhysiologyProfile, at: EpochMs): number | null {
  if (profile.maxHeartRate !== null) return profile.maxHeartRate;
  return profile.birthYear === null ? null : tanakaMaxHeartRate(ageAt(profile.birthYear, at));
}

/** Zones 1 to 5 over 50-60, 60-70, 70-80, 80-90 and 90-100 % of the maximum heart rate (`CAL-004`). */
export function heartRateZones(maxHeartRate: number): readonly HeartRateZoneBounds[] {
  return heartRateZoneKeys.map((zone) => ({ zone, minBpm: (maxHeartRate * (40 + 10 * zone)) / 100, maxBpm: (maxHeartRate * (50 + 10 * zone)) / 100 }));
}

/** Zone of a heart rate (`heart_rate_zone`), `null` under zone 1. */
export function heartRateZoneOf(bpm: number, zones: readonly HeartRateZoneBounds[]): HeartRateZone | null {
  for (let index = zones.length - 1; index >= 0; index -= 1) {
    const bounds = zones[index];
    if (bounds !== undefined && bpm >= bounds.minBpm) return bounds.zone;
  }
  return null;
}

/** Heart rate holding at increasing times: the last reading at most `heartRateHoldMs` old, `null` during a dropout. */
export function heartRateReader(heartRate: HeartRateColumns): (t: number) => number | null {
  let index = -1;
  return (t: number): number | null => {
    while (index + 1 < heartRate.length && (heartRate.t[index + 1] ?? 0) <= t) index += 1;
    if (index < 0) return null;
    const bpm = heartRate.bpm[index] ?? 0;
    return isHeartRateReading(bpm) && t - (heartRate.t[index] ?? 0) < heartRateHoldMs ? bpm : null;
  };
}

/**
 * Visits every interval during which a reading holds, clipped to `window`, in time order: from each reading to the next one, at
 * most `heartRateHoldMs`. Samples that are not readings end the previous hold.
 */
export function forEachHeartRateSpan(heartRate: HeartRateColumns, window: TimeSpan, visit: (startMs: number, endMs: number, bpm: number) => void): void {
  const { length, t, bpm } = heartRate;
  for (let index = 0; index < length; index += 1) {
    const rate = bpm[index] ?? 0;
    if (!isHeartRateReading(rate)) continue;
    const at = t[index] ?? 0;
    const next = index + 1 < length ? (t[index + 1] ?? at) : Number.POSITIVE_INFINITY;
    const startMs = Math.max(at, window.startMs);
    const endMs = Math.min(next, at + heartRateHoldMs, window.endMs);
    if (endMs > startMs) visit(startMs, endMs, rate);
  }
}

/** Overlap of successive, non-decreasing intervals with sorted disjoint spans, in a single forward pass. */
export class SpanOverlap {
  private readonly spans: readonly TimeSpan[];
  private index = 0;

  constructor(spans: readonly TimeSpan[]) {
    this.spans = spans;
  }

  /** Milliseconds of `[startMs, endMs)` inside the spans; `startMs` must not decrease between calls. */
  of(startMs: number, endMs: number): number {
    const spans = this.spans;
    while (this.index < spans.length && (spans[this.index]?.endMs ?? 0) <= startMs) this.index += 1;
    let total = 0;
    for (let index = this.index; index < spans.length; index += 1) {
      const span = spans[index];
      if (span === undefined || span.startMs >= endMs) break;
      total += Math.min(endMs, span.endMs) - Math.max(startMs, span.startMs);
    }
    return total;
  }
}

/** Smallest span enclosing sorted disjoint spans. */
function envelope(spans: readonly TimeSpan[]): TimeSpan {
  return { startMs: spans[0]?.startMs ?? 0, endMs: spans.at(-1)?.endMs ?? 0 };
}

/** Time spent in each zone while a reading holds, inside `within` (sorted, disjoint): the moving intervals for the detail. */
export function timeInZones(heartRate: HeartRateColumns, zones: readonly HeartRateZoneBounds[], within: readonly TimeSpan[]): TimeInZones {
  const byZone: Record<HeartRateZone, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let coveredMs = 0;
  let belowMs = 0;
  const overlap = new SpanOverlap(within);
  forEachHeartRateSpan(heartRate, envelope(within), (startMs, endMs, bpm) => {
    const duration = overlap.of(startMs, endMs);
    if (duration === 0) return;
    coveredMs += duration;
    const zone = heartRateZoneOf(bpm, zones);
    if (zone === null) belowMs += duration;
    else byZone[zone] += duration;
  });
  return { coveredMs, belowMs, byZone };
}
