import type { EpochMs, FieldValues, LapTrigger, SportKey } from "@obnixe/schema";
import { sportOf } from "../../activity/catalog.ts";
import { encodeUtf8 } from "../../data/utf8.ts";
import { localDateOf } from "../../dates.ts";
import { activityWindow, fixAt } from "../batch.ts";
import type { ProcessedTrack, TrackTrim } from "../batch.ts";
import type { Track } from "../codec/track.ts";
import { ellipsoidDistance } from "../geo.ts";
import { maskTrack } from "../privacy.ts";
import type { PrivacyMask } from "../privacyZones.ts";
import { orthometricAltitude } from "../stages/altitude.ts";
import { bridgeMaximumMs, intervalCodes, PauseLedger } from "../stages/derive.ts";
import type { PressureColumns, StepColumns } from "../types.ts";
import { heartRateReader } from "../zones.ts";
import type { TimeSpan } from "../zones.ts";
import type { ExportPoint, FileTimerEvent } from "./activity.ts";
import { writeFit } from "./fit.ts";
import type { FitLap, FitStretch } from "./fit.ts";
import { writeGpx } from "./gpx.ts";
import { fitSportOf, tcxSportOf } from "./sports.ts";
import { writeTcx } from "./tcx.ts";
import type { TcxLap, TcxTrigger } from "./tcx.ts";

/** Step samples further apart than this give no cadence. */
const cadenceSpanMs = 10_000;
const pressureHoldMs = 5000;
const maxGpxCadence = 254;

export const exportFormats = ["gpx", "fit", "tcx"] as const;
export type ExportFormat = (typeof exportFormats)[number];

export const exportMimeTypes: Readonly<Record<ExportFormat, string>> = {
  gpx: "application/gpx+xml",
  fit: "application/vnd.ant.fit",
  tcx: "application/vnd.garmin.tcx+xml",
};

export interface ActivityExportInput {
  readonly track: Track;
  /** The processed track of a sport with a profile: only the fixes kept by stages 2 and 3 are exported. `null` exports every fix. */
  readonly processed: ProcessedTrack | null;
  readonly trim: TrackTrim;
  readonly sport: SportKey;
  /** Session values: the bike kind and assistance and the swim water give the FIT sub sport (annex D). */
  readonly values: FieldValues;
  readonly title: string | null;
  /** `exportPrivacyMask`: `null` exports the full track. */
  readonly mask: PrivacyMask | null;
  /** `recording.energy_kcal`, spread over the laps by timer time. */
  readonly energyKcal: number | null;
}

export interface ExportNameInput {
  readonly startedAt: EpochMs;
  readonly timeZone: string;
  readonly title: string | null;
  readonly sport: SportKey;
}

interface ExportedFix {
  readonly index: number;
  /** A pause, a gap or a masked part separates it from the previous exported fix. */
  readonly startsPart: boolean;
  readonly distanceMm: number;
}

interface ExportStretch extends TimeSpan {
  /** Elapsed time outside the manual pauses. */
  readonly timerMs: number;
  readonly distanceMm: number;
  readonly heartRateAvg: number | null;
  readonly heartRateMax: number | null;
}

interface ExportLap extends ExportStretch {
  readonly trigger: LapTrigger;
}

/** What every format writes, on the track time base: the points left by the mask in continuous parts, the pauses, laps and totals. */
interface ExportedActivity {
  readonly window: TimeSpan;
  readonly pauses: readonly TimeSpan[];
  readonly parts: readonly (readonly ExportPoint[])[];
  readonly laps: readonly ExportLap[];
  readonly totals: ExportStretch;
}

const insidePause = (pauses: readonly TimeSpan[], t: number): boolean => pauses.some((span) => t > span.startMs && t < span.endMs);
const pauseBetween = (pauses: readonly TimeSpan[], from: number, to: number): boolean => pauses.some((span) => span.startMs >= from && span.startMs < to);

function timerMsOf(span: TimeSpan, pauses: readonly TimeSpan[]): number {
  const paused = pauses.reduce((total, pause) => total + Math.max(0, Math.min(pause.endMs, span.endMs) - Math.max(pause.startMs, span.startMs)), 0);
  return span.endMs - span.startMs - paused;
}

/** The fixes of the trimmed window at their original instants (`IO-002`), outside the manual pauses, with the counted distance. */
function exportedFixes(input: ActivityExportInput, window: TimeSpan, pauses: readonly TimeSpan[]): readonly ExportedFix[] {
  const { track, processed } = input;
  const exported: ExportedFix[] = [];
  if (processed !== null) {
    const { series } = processed;
    let cut = true;
    for (let index = 0; index < series.length; index += 1) {
      const t = series.t[index] ?? 0;
      if (insidePause(pauses, t)) {
        cut = true;
        continue;
      }
      const code = series.interval[index];
      exported.push({ index: series.fixIndex[index] ?? 0, startsPart: cut || code === intervalCodes.paused || code === intervalCodes.gap, distanceMm: Math.round((series.distance[index] ?? 0) * 1000) });
      cut = false;
    }
    return exported;
  }
  const { fixes } = track.samples;
  let previous: number | null = null;
  let distanceMm = 0;
  let cut = true;
  for (let index = 0; index < fixes.length; index += 1) {
    const t = fixes.t[index] ?? 0;
    if (t < window.startMs || t > window.endMs) continue;
    if (insidePause(pauses, t)) {
      cut = true;
      continue;
    }
    const startsPart = cut || previous === null || t - (fixes.t[previous] ?? 0) > bridgeMaximumMs || pauseBetween(pauses, fixes.t[previous] ?? 0, t);
    if (!startsPart && previous !== null) {
      distanceMm += ellipsoidDistance((fixes.latitudeE7[previous] ?? 0) / 1e7, (fixes.longitudeE7[previous] ?? 0) / 1e7, (fixes.latitudeE7[index] ?? 0) / 1e7, (fixes.longitudeE7[index] ?? 0) / 1e7) * 1000;
    }
    exported.push({ index, startsPart, distanceMm: Math.round(distanceMm) });
    previous = index;
    cut = false;
  }
  return exported;
}

/** The last pressure at most `pressureHoldMs` old, for increasing times. */
function pressureReader(pressure: PressureColumns): (t: number) => number | null {
  let next = 0;
  return (t) => {
    while (next < pressure.length && (pressure.t[next] ?? 0) <= t) next += 1;
    const at = pressure.t[next - 1];
    return at === undefined || t - at > pressureHoldMs ? null : (pressure.pascals[next - 1] ?? null);
  };
}

/** Strides per minute (half the step rate) between the step samples around each increasing time. */
function cadenceReader(steps: StepColumns): (t: number) => number | null {
  let index = 0;
  return (t) => {
    while (index + 1 < steps.length && (steps.t[index + 1] ?? 0) < t) index += 1;
    const from = steps.t[index] ?? 0;
    const to = steps.t[index + 1];
    if (to === undefined || index + 1 >= steps.length || t < from || to - from > cadenceSpanMs || to <= from) return null;
    const stepsPerMinute = (((steps.count[index + 1] ?? 0) - (steps.count[index] ?? 0)) * 60_000) / (to - from);
    return Math.min(Math.round(stepsPerMinute / 2), maxGpxCadence);
  };
}

function exportedLaps(input: ActivityExportInput, window: TimeSpan, pauses: readonly TimeSpan[], distanceMm: number): readonly ExportLap[] {
  const { processed } = input;
  if (processed === null) return [{ ...window, timerMs: timerMsOf(window, pauses), distanceMm, heartRateAvg: null, heartRateMax: null, trigger: "manual" }];
  return processed.laps.map((lap) => ({
    startMs: lap.startMs,
    endMs: lap.endMs,
    timerMs: timerMsOf(lap, pauses),
    distanceMm: lap.distanceMm,
    heartRateAvg: lap.heartRateAvg,
    heartRateMax: lap.heartRateMax,
    trigger: lap.bounds.trigger,
  }));
}

/**
 * The original fixes kept by stages 2 and 3 inside the trim (`IO-002`), in continuous parts cut at each manual pause and each
 * gap, and at each part the privacy mask removes (`PRV-010`, `PRV-011`).
 */
function exportedActivity(input: ActivityExportInput): ExportedActivity {
  const { track, mask, processed } = input;
  const window = processed?.elapsed ?? activityWindow(track.samples, track.marks, input.trim);
  let pauses = processed?.pauses;
  if (pauses === undefined) {
    const ledger = new PauseLedger();
    for (const mark of track.marks) ledger.mark(mark);
    pauses = ledger.spans(window);
  }
  const { fixes } = track.samples;
  const exported = exportedFixes(input, window, pauses);
  const positions = {
    length: exported.length,
    latitude: Float64Array.from(exported, (fix) => (fixes.latitudeE7[fix.index] ?? 0) / 1e7),
    longitude: Float64Array.from(exported, (fix) => (fixes.longitudeE7[fix.index] ?? 0) / 1e7),
  };
  const hidden = mask === null ? new Uint8Array(exported.length) : maskTrack(positions, mask.zones, mask).hidden;
  const heartRateAt = heartRateReader(track.samples.heartRate);
  const cadenceAt = cadenceReader(track.samples.steps);
  const pressureAt = pressureReader(track.samples.pressure);
  const parts: ExportPoint[][] = [];
  let current: ExportPoint[] | null = null;
  for (let position = 0; position < exported.length; position += 1) {
    const entry = exported[position];
    if (entry === undefined || hidden[position] === 1) {
      current = null;
      continue;
    }
    const fix = fixAt(fixes, entry.index);
    const altitude = orthometricAltitude(fix);
    if (current === null || entry.startsPart) {
      current = [];
      parts.push(current);
    }
    current.push({
      latitudeE7: fix.latitudeE7,
      longitudeE7: fix.longitudeE7,
      altitudeMm: altitude === null ? null : Math.round(altitude * 1000),
      time: track.startedAt + fix.t,
      heartRate: heartRateAt(fix.t),
      cadence: cadenceAt(fix.t),
      speedMmS: fix.speedCmS === null ? null : fix.speedCmS * 10,
      courseCentiDeg: fix.speedCmS === null ? null : fix.bearingCentiDeg,
      horizontalAccuracyDm: fix.horizontalAccuracyDm,
      verticalAccuracyDm: altitude === null ? null : fix.verticalAccuracyDm,
      speedAccuracyCmS: fix.speedCmS === null ? null : fix.speedAccuracyCmS,
      pressurePa: pressureAt(fix.t),
      distanceMm: entry.distanceMm,
    });
  }
  const distanceMm = processed?.summary.distanceMm ?? exported[exported.length - 1]?.distanceMm ?? 0;
  const totals: ExportStretch = {
    ...window,
    timerMs: timerMsOf(window, pauses),
    distanceMm,
    heartRateAvg: processed?.summary.heartRateAvg ?? null,
    heartRateMax: processed?.summary.heartRateMax ?? null,
  };
  return { window, pauses, parts, laps: exportedLaps(input, window, pauses, distanceMm), totals };
}

const titleOf = (input: ActivityExportInput): string => input.title ?? sportOf(input.sport).label;

/** The GPX export of an activity (`IO-001`, `IO-002`): one `trkseg` per continuous part. */
export function exportGpx(input: ActivityExportInput): string {
  const activity = exportedActivity(input);
  return writeGpx({ name: titleOf(input), time: input.track.startedAt + activity.window.startMs, type: input.sport, segments: activity.parts });
}

function lapEnergy(input: ActivityExportInput, lap: ExportStretch, totals: ExportStretch): number | null {
  if (input.energyKcal === null) return null;
  return totals.timerMs <= 0 ? 0 : Math.round((input.energyKcal * lap.timerMs) / totals.timerMs);
}

function tcxTrigger(trigger: LapTrigger): TcxTrigger {
  switch (trigger) {
    case "manual":
    case "workout":
    case "import":
      return "Manual";
    case "distance":
      return "Distance";
    case "duration":
      return "Time";
    default: {
      const unhandled: never = trigger;
      throw new Error(`No TCX trigger for ${String(unhandled)}`);
    }
  }
}

/** The parts of the activity inside `[startMs, endMs)`, or up to `endMs` included for the last lap. */
function lapTracks(parts: readonly (readonly ExportPoint[])[], startedAt: number, lap: TimeSpan, last: boolean): readonly (readonly ExportPoint[])[] {
  return parts
    .map((part) =>
      part.filter((point) => {
        const t = point.time - startedAt;
        return t >= lap.startMs && (t < lap.endMs || (last && t === lap.endMs));
      }),
    )
    .filter((part) => part.length > 0);
}

/** The TCX export (`IO-003`): the GPX points (`IO-002`), one `Lap` per lap with one `Track` per continuous part inside it. */
export function exportTcx(input: ActivityExportInput): string {
  const activity = exportedActivity(input);
  const { startedAt } = input.track;
  const laps = activity.laps.map(
    (lap, index): TcxLap => ({
      startTime: startedAt + lap.startMs,
      timerMs: lap.timerMs,
      distanceMm: lap.distanceMm,
      energyKcal: lapEnergy(input, lap, activity.totals) ?? 0,
      heartRateAvg: lap.heartRateAvg,
      heartRateMax: lap.heartRateMax,
      trigger: tcxTrigger(lap.trigger),
      tracks: lapTracks(activity.parts, startedAt, lap, index === activity.laps.length - 1),
    }),
  );
  return writeTcx({ sport: tcxSportOf(input.sport), startTime: startedAt + activity.window.startMs, laps });
}

function fitStretch(input: ActivityExportInput, stretch: ExportStretch, totals: ExportStretch): FitStretch {
  const { startedAt } = input.track;
  return {
    startTime: startedAt + stretch.startMs,
    endTime: startedAt + stretch.endMs,
    timerMs: stretch.timerMs,
    distanceMm: stretch.distanceMm,
    energyKcal: lapEnergy(input, stretch, totals),
    heartRateAvg: stretch.heartRateAvg,
    heartRateMax: stretch.heartRateMax,
  };
}

/** Timer start at the window start and each resume, stop at each pause and at the end. */
function timerEvents(startedAt: number, window: TimeSpan, pauses: readonly TimeSpan[]): readonly FileTimerEvent[] {
  const timer: FileTimerEvent[] = [{ time: startedAt + window.startMs, kind: "start" }];
  for (const pause of pauses) {
    if (pause.startMs <= window.startMs || pause.startMs >= window.endMs) continue;
    timer.push({ time: startedAt + pause.startMs, kind: "stop" });
    if (pause.endMs < window.endMs) timer.push({ time: startedAt + pause.endMs, kind: "start" });
  }
  if (timer[timer.length - 1]?.kind === "start") timer.push({ time: startedAt + window.endMs, kind: "stop" });
  return timer;
}

/** The FIT export (`IO-003`): the GPX points (`IO-002`) as records, timer events at the pauses, the laps and the session. */
export function exportFit(input: ActivityExportInput): Uint8Array {
  const activity = exportedActivity(input);
  const { startedAt } = input.track;
  return writeFit({
    sport: fitSportOf(input.sport, input.values),
    timer: timerEvents(startedAt, activity.window, activity.pauses),
    points: activity.parts.flat(),
    laps: activity.laps.map((lap): FitLap => ({ ...fitStretch(input, lap, activity.totals), trigger: lap.trigger })),
    session: { ...fitStretch(input, activity.totals, activity.totals), energyKcal: input.energyKcal },
  });
}

/** The exported file in `format`, as bytes. */
export function exportActivity(input: ActivityExportInput, format: ExportFormat): Uint8Array {
  switch (format) {
    case "gpx":
      return encodeUtf8(exportGpx(input));
    case "tcx":
      return encodeUtf8(exportTcx(input));
    case "fit":
      return exportFit(input);
    default: {
      const unhandled: never = format;
      throw new Error(`No export for ${String(unhandled)}`);
    }
  }
}

function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `obnixe-YYYY-MM-DD-<normalized title>.<extension>` (`IO-004`), the local date of the start, the sport name without a title. */
export function exportFileName(input: ExportNameInput, extension: ExportFormat | "png"): string {
  const name = slug(input.title ?? "") || slug(sportOf(input.sport).label);
  return `obnixe-${localDateOf(input.startedAt, input.timeZone)}${name === "" ? "" : `-${name}`}.${extension}`;
}
