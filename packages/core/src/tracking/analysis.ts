import { settings } from "@obnixe/schema";
import type { EpochMs } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import type { ProcessedTrack } from "./batch.ts";
import type { Track } from "./codec/track.ts";
import { reprocessRecording } from "./plans.ts";
import type { SessionRecording } from "./plans.ts";
import type { ResolvedProfile } from "./profile.ts";
import type { HeartRateColumns } from "./types.ts";
import { heartRateZones, maxHeartRateOf, timeInZones } from "./zones.ts";
import type { HeartRateZoneBounds, TimeInZones, TimeSpan } from "./zones.ts";

/**
 * A saved recording measured at its stored trim and laps (`SUM-001`), shared by the detail screen and the agent so both read
 * the splits, laps and best efforts that the stored summary was computed with.
 */
export function analyzeRecording(db: ObnixeDatabase, saved: SessionRecording, profile: ResolvedProfile, track: Track): ProcessedTrack {
  return reprocessRecording(db, saved, track, { startMs: saved.recording.trimStartMs, endMs: saved.recording.trimEndMs }, profile);
}

export type MaxHeartRateSource = "settings" | "birth_year";

export interface HeartRateZoneReport {
  readonly maxHeartRate: number;
  readonly source: MaxHeartRateSource;
  readonly zones: readonly HeartRateZoneBounds[];
  readonly time: TimeInZones;
}

/** Moving time in the zones of the maximum heart rate at the activity date (`CAL-004`); `null` without a stream or a maximum. */
export function heartRateZoneReport(db: ObnixeDatabase, startedAt: EpochMs, heartRate: HeartRateColumns, moving: readonly TimeSpan[]): HeartRateZoneReport | null {
  if (heartRate.length === 0) return null;
  const physiology = db.select({ birthYear: settings.birthYear, sex: settings.sex, maxHeartRate: settings.maxHeartRate }).from(settings).get();
  if (physiology === undefined) return null;
  const maxHeartRate = maxHeartRateOf(physiology, startedAt);
  if (maxHeartRate === null) return null;
  const zones = heartRateZones(maxHeartRate);
  return { maxHeartRate, source: physiology.maxHeartRate === null ? "birth_year" : "settings", zones, time: timeInZones(heartRate, zones, moving) };
}
