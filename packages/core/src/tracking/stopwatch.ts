import { processTrack } from "./batch.ts";
import type { ProcessedTrack } from "./batch.ts";
import type { Track } from "./codec/track.ts";
import type { ResolvedProfile } from "./profile.ts";
import { heartRateMaxBetween } from "./stages/derive.ts";
import { heartRateAverageCoverage } from "./summary.ts";
import type { LapSummary } from "./stages/derive.ts";
import { toSampleColumns } from "./types.ts";
import type { HeartRateColumns } from "./types.ts";
import { forEachHeartRateSpan } from "./zones.ts";
import type { TimeSpan } from "./zones.ts";

interface HeartRateCover {
  readonly beats: number;
  readonly coveredMs: number;
}

function coverOf(heartRate: HeartRateColumns, spans: readonly TimeSpan[]): HeartRateCover {
  let beats = 0;
  let coveredMs = 0;
  for (const span of spans) {
    forEachHeartRateSpan(heartRate, span, (startMs, endMs, bpm) => {
      beats += bpm * (endMs - startMs);
      coveredMs += endMs - startMs;
    });
  }
  return { beats, coveredMs };
}

const averageOf = (cover: HeartRateCover): number | null => (cover.coveredMs === 0 ? null : Math.round(cover.beats / cover.coveredMs));

function clip(spans: readonly TimeSpan[], window: TimeSpan): readonly TimeSpan[] {
  return spans.flatMap((span) => {
    const startMs = Math.max(span.startMs, window.startMs);
    const endMs = Math.min(span.endMs, window.endMs);
    return endMs > startMs ? [{ startMs, endMs }] : [];
  });
}

const lengthOf = (spans: readonly TimeSpan[]): number => spans.reduce((total, span) => total + span.endMs - span.startMs, 0);

/**
 * `REC-060`: a stopwatch recording measured from its marks, without positions. The moving time is the window without the
 * manual pauses, the heart rate is averaged over it, and the distance is the one typed at the stop (0 without one). Each
 * manual lap closes a lap, as recorded laps do. A sport that measures no heart rate keeps none, even from a stray stream;
 * cadence and power are not recorded without location.
 */
export function processStopwatch(track: Track, profile: ResolvedProfile, distanceMm: number): ProcessedTrack {
  const base = processTrack(track, profile, { laps: { kind: "given", laps: [] }, trim: { startMs: 0, endMs: null } });
  const window = base.elapsed;
  const moving: TimeSpan[] = [];
  let from = window.startMs;
  for (const pause of [...base.pauses, { startMs: window.endMs, endMs: window.endMs }]) {
    if (pause.startMs > from) moving.push({ startMs: from, endMs: pause.startMs });
    from = Math.max(from, pause.endMs);
  }
  const heartRate = profile.metrics.includes("heart_rate") ? track.samples.heartRate : toSampleColumns([]).heartRate;
  const cover = coverOf(heartRate, moving);
  const movingMs = lengthOf(moving);
  const maxOf = (span: TimeSpan): number | null => (heartRate.length === 0 ? null : heartRateMaxBetween(heartRate, span.startMs, span.endMs + 1));
  const boundaries = track.marks.filter((mark) => mark.kind === "lap" && mark.t > window.startMs && mark.t < window.endMs).map((mark) => mark.t);
  const laps: LapSummary[] = [];
  let lapStart = window.startMs;
  for (const endMs of [...boundaries, window.endMs]) {
    if (endMs <= lapStart) continue;
    const span = { startMs: lapStart, endMs };
    const lapMoving = clip(moving, span);
    laps.push({
      bounds: { trigger: "manual", startOffsetMs: lapStart - window.startMs, endOffsetMs: endMs - window.startMs, workoutStep: null },
      ...span,
      distanceMm: 0,
      elapsedMs: endMs - lapStart,
      movingMs: lengthOf(lapMoving),
      ascentMm: null,
      descentMm: null,
      gradeAdjustedDistanceMm: null,
      cadenceAvg: null,
      powerAvg: null,
      heartRateAvg: averageOf(coverOf(heartRate, lapMoving)),
      heartRateMax: maxOf(span),
    });
    lapStart = endMs;
  }
  return {
    ...base,
    intervals: [],
    moving,
    summary: {
      ...base.summary,
      elapsedMs: window.endMs - window.startMs,
      movingMs,
      distanceMm,
      cadenceAvg: null,
      powerAvg: null,
      heartRateAvg: cover.coveredMs >= heartRateAverageCoverage * movingMs ? averageOf(cover) : null,
      heartRateMax: maxOf(window),
      heartRateSource: heartRate.length === 0 ? "none" : base.summary.heartRateSource,
    },
    details: { ...base.details, heartRateCoveragePermille: heartRate.length === 0 || movingMs <= 0 ? null : Math.round((cover.coveredMs * 1000) / movingMs) },
    splits: [],
    laps,
    bestEfforts: [],
    climbs: [],
    descents: [],
  };
}
