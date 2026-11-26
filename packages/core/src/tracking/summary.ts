import type { BoundingBoxE7, CadenceSource, ElevationSource, FieldValue, FieldValues, RecordingProfile, SensorSource, SportKey } from "@obnixe/schema";
import { sportOf } from "../activity/catalog.ts";
import { BoundingBoxBuilder } from "./geo.ts";
import { sensorAverage } from "./sensors.ts";
import { heartRateMaxBetween, isCountedCode, maxWindowSpeed } from "./stages/derive.ts";
import type { SensorSeries, TrackSeries } from "./stages/derive.ts";
import type { FixColumns, SampleColumns } from "./types.ts";
import { trackingAlgorithmVersion } from "./version.ts";
import type { TimeSpan } from "./zones.ts";

/** Counted time with a fix within this accuracy is a good fix (`PR-002`). */
export const goodFixAccuracyDm = 200;
/** Counted time with a fix within this accuracy is a precise fix (`SUM-001`). */
export const preciseFixAccuracyDm = 100;
/** Share of the moving time a heart-rate source must cover for `heart_rate_avg` (`SPT-003`). */
export const heartRateAverageCoverage = 0.5;

/** The computed columns of a `recording` row (`DAT-001`). */
export interface RecordingSummary {
  readonly algorithmVersion: number;
  readonly elapsedMs: number;
  readonly movingMs: number;
  readonly distanceMm: number;
  readonly ascentMm: number | null;
  readonly descentMm: number | null;
  readonly altitudeMinMm: number | null;
  readonly altitudeMaxMm: number | null;
  readonly speedMaxMmS: number | null;
  /** Steps per minute of moving time, or the mean of the Bluetooth cadence while pedaling or striding when it covers half of it. */
  readonly cadenceAvg: number | null;
  readonly steps: number | null;
  /** Weighted by moving time, when the heart rate covers half of it. */
  readonly heartRateAvg: number | null;
  readonly heartRateMax: number | null;
  /** Watts weighted by moving time, when the power meter covers half of it (`SPT-008`). */
  readonly powerAvg: number | null;
  readonly goodFixPermille: number;
  readonly bbox: BoundingBoxE7 | null;
  /** Fixes recorded in the window, before the gate. */
  readonly pointCount: number;
  readonly simulated: boolean;
  readonly elevationSource: ElevationSource;
  readonly cadenceSource: CadenceSource;
  readonly heartRateSource: SensorSource;
}

/** Values of the detailed summary that have no `recording` column. */
export interface TrackDetails {
  readonly gradeAdjustedDistanceMm: number | null;
  /** m/h over the moving intervals steeper than 3 % (`ELE-021`). */
  readonly vamMetersPerHour: number | null;
  readonly preciseFixPermille: number;
  /** Share of the moving time covered by a heart-rate reading. */
  readonly heartRateCoveragePermille: number | null;
  readonly gateRejections: number;
  readonly outlierRejections: number;
}

export interface SummaryInput {
  readonly series: TrackSeries;
  readonly samples: SampleColumns;
  readonly window: TimeSpan;
  readonly elevationSource: ElevationSource;
  readonly simulated: boolean;
}

interface AccuracyShares {
  readonly goodPermille: number;
  readonly precisePermille: number;
}

/** Shares of the counted time whose ending fix is within the good and precise accuracies. */
export function accuracyShares(series: TrackSeries, fixes: FixColumns): AccuracyShares {
  let counted = 0;
  let good = 0;
  let precise = 0;
  for (let index = 1; index < series.length; index += 1) {
    if (!isCountedCode(series.interval[index] ?? 0)) continue;
    const duration = (series.t[index] ?? 0) - (series.t[index - 1] ?? 0);
    const accuracy = fixes.horizontalAccuracyDm[series.fixIndex[index] ?? 0] ?? Number.POSITIVE_INFINITY;
    counted += duration;
    if (accuracy <= goodFixAccuracyDm) good += duration;
    if (accuracy <= preciseFixAccuracyDm) precise += duration;
  }
  return counted === 0 ? { goodPermille: 0, precisePermille: 0 } : { goodPermille: Math.round((good * 1000) / counted), precisePermille: Math.round((precise * 1000) / counted) };
}

const last = (column: Float64Array | null): number => (column === null ? 0 : (column[column.length - 1] ?? 0));

const sensorMean = (sensor: SensorSeries | null, movingMs: number): number | null =>
  sensor === null ? null : sensorAverage(last(sensor.integral), last(sensor.averagedMs), last(sensor.coveredMs), movingMs);

function cadenceSourceOf(series: TrackSeries): CadenceSource {
  if (series.cadence !== null) return "sensor";
  return series.steps === null ? "none" : "pedometer";
}

function stepsIn(samples: SampleColumns, window: TimeSpan): number | null {
  const { t, count, length } = samples.steps;
  let first = -1;
  let final = -1;
  for (let index = 0; index < length; index += 1) {
    const at = t[index] ?? 0;
    if (at < window.startMs || at > window.endMs) continue;
    if (first < 0) first = index;
    final = index;
  }
  return first < 0 ? null : (count[final] ?? 0) - (count[first] ?? 0);
}

function fixesIn(fixes: FixColumns, window: TimeSpan): number {
  let count = 0;
  for (let index = 0; index < fixes.length; index += 1) {
    const at = fixes.t[index] ?? 0;
    if (at >= window.startMs && at <= window.endMs) count += 1;
  }
  return count;
}

/** The `recording` columns computed from the processed series (`SUM-001`). */
export function summarizeRecording(input: SummaryInput): RecordingSummary {
  const { series, samples, window, elevationSource } = input;
  const movingMs = last(series.moving);
  const hasElevation = elevationSource !== "none";
  let altitudeMin = Number.POSITIVE_INFINITY;
  let altitudeMax = Number.NEGATIVE_INFINITY;
  const bbox = new BoundingBoxBuilder();
  for (let index = 0; index < series.length; index += 1) {
    const altitude = series.altitude[index] ?? Number.NaN;
    if (altitude < altitudeMin) altitudeMin = altitude;
    if (altitude > altitudeMax) altitudeMax = altitude;
    bbox.include(series.latitude[index] ?? 0, series.longitude[index] ?? 0);
  }
  const speedMax = maxWindowSpeed(series);
  const coveredMs = last(series.heartRateMs);
  const hasHeartRate = samples.heartRate.length > 0;
  return {
    algorithmVersion: trackingAlgorithmVersion,
    elapsedMs: Math.round(window.endMs - window.startMs),
    movingMs: Math.round(movingMs),
    distanceMm: Math.round(last(series.distance) * 1000),
    ascentMm: hasElevation ? Math.round(last(series.ascent) * 1000) : null,
    descentMm: hasElevation ? Math.round(last(series.descent) * 1000) : null,
    altitudeMinMm: altitudeMin <= altitudeMax ? Math.round(altitudeMin * 1000) : null,
    altitudeMaxMm: altitudeMin <= altitudeMax ? Math.round(altitudeMax * 1000) : null,
    speedMaxMmS: speedMax === null ? null : Math.round(speedMax * 1000),
    cadenceAvg: series.cadence !== null ? sensorMean(series.cadence, movingMs) : series.steps === null || movingMs <= 0 ? null : Math.round((last(series.steps) * 60_000) / movingMs),
    steps: series.steps === null ? null : stepsIn(samples, window),
    heartRateAvg: coveredMs > 0 && coveredMs >= heartRateAverageCoverage * movingMs ? Math.round((last(series.heartBeats) * 60_000) / coveredMs) : null,
    heartRateMax: hasHeartRate ? heartRateMaxBetween(samples.heartRate, window.startMs, window.endMs + 1) : null,
    powerAvg: sensorMean(series.power, movingMs),
    goodFixPermille: accuracyShares(series, samples.fixes).goodPermille,
    bbox: bbox.build(),
    pointCount: fixesIn(samples.fixes, window),
    simulated: input.simulated,
    elevationSource,
    cadenceSource: cadenceSourceOf(series),
    heartRateSource: hasHeartRate ? "sensor" : "none",
  };
}

const fileElevation = (source: ElevationSource): ElevationSource => (source === "none" || source === "dem" ? source : "file");
const fileCadence = (source: CadenceSource): CadenceSource => (source === "none" ? "none" : "file");
const fileSensor = (source: SensorSource): SensorSource => (source === "none" ? "none" : "file");

/** The summary of an imported track: its altitude, cadence and heart rate all come from the file, unless the DEM corrected its altitude. */
export function importedSummary(summary: RecordingSummary): RecordingSummary {
  return { ...summary, elevationSource: fileElevation(summary.elevationSource), cadenceSource: fileCadence(summary.cadenceSource), heartRateSource: fileSensor(summary.heartRateSource) };
}

export interface SessionValuesUpdate {
  readonly values: FieldValues;
  readonly pausedSeconds: number;
}

type RecordingValues = Pick<RecordingSummary, "elapsedMs" | "movingMs" | "distanceMm" | "ascentMm" | "heartRateAvg" | "powerAvg">;

/** The session values a recording measures: never edited by hand (`SUM-004`, `INT-042`). */
export const recordedValueKeys = ["distance", "elevation_gain", "heart_rate_avg", "power_avg"] as const;

/**
 * The session values derived from the `recording` row (`SPT-003`), at the stop and after any trim or recomputation:
 * the profile's `recordedValues`, `distance`, `elevation_gain` when the profile shows the ascent, `heart_rate_avg`, `power_avg`
 * for the sports that have the field (`SPT-008`), and `paused_seconds = elapsed - moving`.
 */
export function sessionValuesFromRecording(values: FieldValues, recording: RecordingValues, profile: Pick<RecordingProfile, "metrics" | "recordedValues"> & { readonly sport: SportKey }): SessionValuesUpdate {
  const derived: Record<string, FieldValue> = { ...values, ...profile.recordedValues, distance: Math.round(recording.distanceMm / 1000) };
  if (profile.metrics.includes("ascent") && recording.ascentMm !== null) derived.elevation_gain = Math.round(recording.ascentMm / 1000);
  else delete derived.elevation_gain;
  if (recording.heartRateAvg === null) delete derived.heart_rate_avg;
  else derived.heart_rate_avg = recording.heartRateAvg;
  if (recording.powerAvg === null || !sportOf(profile.sport).sessionFields.some((field) => field.key === "power_avg")) delete derived.power_avg;
  else derived.power_avg = recording.powerAvg;
  return { values: derived, pausedSeconds: Math.round((recording.elapsedMs - recording.movingMs) / 1000) };
}
