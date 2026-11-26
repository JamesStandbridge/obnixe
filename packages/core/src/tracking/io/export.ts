import type { EpochMs, SportKey } from "@obnixe/schema";
import { sportOf } from "../../activity/catalog.ts";
import { localDateOf } from "../../dates.ts";
import { activityWindow, fixAt } from "../batch.ts";
import type { ProcessedTrack, TrackTrim } from "../batch.ts";
import type { Track } from "../codec/track.ts";
import { maskTrack } from "../privacy.ts";
import type { PrivacyMask } from "../privacyZones.ts";
import { orthometricAltitude } from "../stages/altitude.ts";
import { bridgeMaximumMs, intervalCodes, PauseLedger } from "../stages/derive.ts";
import type { PressureColumns, StepColumns } from "../types.ts";
import { heartRateReader } from "../zones.ts";
import type { TimeSpan } from "../zones.ts";
import { writeGpx } from "./gpx.ts";
import type { GpxPoint } from "./gpx.ts";

/** Step samples further apart than this give no cadence. */
const cadenceSpanMs = 10_000;
const pressureHoldMs = 5000;
const maxGpxCadence = 254;

export interface GpxExportInput {
  readonly track: Track;
  /** The processed track of a sport with a profile: only the fixes kept by stages 2 and 3 are exported. `null` exports every fix. */
  readonly processed: ProcessedTrack | null;
  readonly trim: TrackTrim;
  readonly sport: SportKey;
  readonly title: string | null;
  /** `exportPrivacyMask`: `null` exports the full track. */
  readonly mask: PrivacyMask | null;
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
}

const insidePause = (pauses: readonly TimeSpan[], t: number): boolean => pauses.some((span) => t > span.startMs && t < span.endMs);
const pauseBetween = (pauses: readonly TimeSpan[], from: number, to: number): boolean => pauses.some((span) => span.startMs >= from && span.startMs < to);

/** The fixes of the trimmed window at their original instants (`IO-002`), outside the manual pauses. */
function exportedFixes(input: GpxExportInput): readonly ExportedFix[] {
  const { track, processed } = input;
  const exported: ExportedFix[] = [];
  if (processed !== null) {
    const { series, pauses } = processed;
    let cut = true;
    for (let index = 0; index < series.length; index += 1) {
      const t = series.t[index] ?? 0;
      if (insidePause(pauses, t)) {
        cut = true;
        continue;
      }
      const code = series.interval[index];
      exported.push({ index: series.fixIndex[index] ?? 0, startsPart: cut || code === intervalCodes.paused || code === intervalCodes.gap });
      cut = false;
    }
    return exported;
  }
  const window = activityWindow(track.samples, track.marks, input.trim);
  const ledger = new PauseLedger();
  for (const mark of track.marks) ledger.mark(mark);
  const pauses = ledger.spans(window);
  const { fixes } = track.samples;
  let previous: number | null = null;
  let cut = true;
  for (let index = 0; index < fixes.length; index += 1) {
    const t = fixes.t[index] ?? 0;
    if (t < window.startMs || t > window.endMs) continue;
    if (insidePause(pauses, t)) {
      cut = true;
      continue;
    }
    exported.push({ index, startsPart: cut || previous === null || t - previous > bridgeMaximumMs || pauseBetween(pauses, previous, t) });
    previous = t;
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

/**
 * The GPX export of an activity (`IO-001`, `IO-002`): the original fixes kept by stages 2 and 3 inside the trim, one `trkseg`
 * per continuous part, cut at each manual pause and each gap, and at each part the privacy mask removes (`PRV-010`, `PRV-011`).
 */
export function exportGpx(input: GpxExportInput): string {
  const { track, mask } = input;
  const { fixes } = track.samples;
  const exported = exportedFixes(input);
  const positions = {
    length: exported.length,
    latitude: Float64Array.from(exported, (fix) => (fixes.latitudeE7[fix.index] ?? 0) / 1e7),
    longitude: Float64Array.from(exported, (fix) => (fixes.longitudeE7[fix.index] ?? 0) / 1e7),
  };
  const hidden = mask === null ? new Uint8Array(exported.length) : maskTrack(positions, mask.zones, mask).hidden;
  const heartRateAt = heartRateReader(track.samples.heartRate);
  const cadenceAt = cadenceReader(track.samples.steps);
  const pressureAt = pressureReader(track.samples.pressure);
  const segments: GpxPoint[][] = [];
  let current: GpxPoint[] | null = null;
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
      segments.push(current);
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
    });
  }
  const window = input.processed?.elapsed ?? activityWindow(track.samples, track.marks, input.trim);
  return writeGpx({ name: input.title ?? sportOf(input.sport).label, time: track.startedAt + window.startMs, type: input.sport, segments });
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
export function exportFileName(input: ExportNameInput, extension: "gpx"): string {
  const name = slug(input.title ?? "") || slug(sportOf(input.sport).label);
  return `obnixe-${localDateOf(input.startedAt, input.timeZone)}${name === "" ? "" : `-${name}`}.${extension}`;
}
