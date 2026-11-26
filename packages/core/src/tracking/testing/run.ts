import type { EpochMs } from "@obnixe/schema";
import { processTrack } from "../batch.ts";
import type { LapSource, ProcessedTrack, TrackTrim } from "../batch.ts";
import type { Track } from "../codec/track.ts";
import { LiveTracker } from "../live.ts";
import type { LiveEvent, LivePoint, LiveSnapshot } from "../live.ts";
import { resolveProfile } from "../profile.ts";
import type { ResolvedProfile } from "../profile.ts";
import { RouteGeometry } from "../route.ts";
import { routePathOf } from "../routes.ts";
import type { AutoLap } from "../stages/derive.ts";
import { toSampleColumns } from "../types.ts";
import type { Fix, Sample, TrackerMark } from "../types.ts";
import type { Scenario, Truth } from "./scenarios.ts";

export function profileOf(scenario: Pick<Scenario, "sport">): ResolvedProfile {
  const profile = resolveProfile(scenario.sport, {});
  if (profile === null) throw new Error(`${scenario.sport} records no track`);
  return profile;
}

export function trackOf(samples: readonly Sample[], marks: readonly TrackerMark[] = []): Track {
  return { startedAt: 1_780_000_000_000 as EpochMs, samples: toSampleColumns(samples), marks };
}

export const untrimmed: TrackTrim = { startMs: 0, endMs: null };
export const recordedLaps: LapSource = { kind: "recorded", autoLap: null };

export function runBatch(scenario: Scenario, marks: readonly TrackerMark[] = [], laps: LapSource = recordedLaps): ProcessedTrack {
  return processTrack(trackOf(scenario.samples, marks), profileOf(scenario), { laps, trim: untrimmed });
}

/** An event with the time of the sample whose arrival raised it. */
export interface TimedEvent {
  readonly event: LiveEvent;
  readonly arrivalT: number;
}

export interface LiveRun {
  readonly tracker: LiveTracker;
  readonly events: readonly TimedEvent[];
  /** Snapshot after each fix. */
  readonly snapshots: readonly LiveSnapshot[];
  readonly track: readonly LivePoint[];
  /** Milliseconds spent in `push` for each sample. */
  readonly timings: Float64Array;
  readonly final: LiveSnapshot;
}

/** Streams the samples and the marks in journal order, a mark before the samples of its instant. */
export function runLive(scenario: Pick<Scenario, "sport" | "samples">, marks: readonly TrackerMark[] = [], autoLap: AutoLap = null, route: RouteGeometry | null = null): LiveRun {
  const tracker = new LiveTracker(profileOf(scenario), autoLap);
  tracker.followRoute(route);
  const events: TimedEvent[] = [];
  const snapshots: LiveSnapshot[] = [];
  const track: LivePoint[] = [];
  const timings = new Float64Array(scenario.samples.length);
  let markIndex = 0;
  let lastT = 0;
  scenario.samples.forEach((sample, index) => {
    for (; markIndex < marks.length && (marks[markIndex]?.t ?? 0) <= sample.t; markIndex += 1) tracker.mark(marks[markIndex] as TrackerMark);
    const started = performance.now();
    const raised = tracker.push(sample);
    timings[index] = performance.now() - started;
    for (const event of raised) events.push({ event, arrivalT: sample.t });
    if (sample.type === "fix") {
      snapshots.push(tracker.snapshot(sample.t));
      track.push(...tracker.takeTrack());
    }
    lastT = sample.t;
  });
  for (; markIndex < marks.length; markIndex += 1) tracker.mark(marks[markIndex] as TrackerMark);
  return { tracker, events, snapshots, track, timings, final: tracker.snapshot(Math.max(lastT, marks.at(-1)?.t ?? 0)) };
}

export function fixesOf(samples: readonly Sample[]): readonly Fix[] {
  return samples.filter((sample): sample is Fix => sample.type === "fix");
}

export function percentile(values: Float64Array, fraction: number): number {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

/** The route drawn by the ground truth, with its altitude as measured by a barometer. */
export function routeOfTruth(truth: Truth): RouteGeometry {
  const points = Array.from({ length: truth.length }, (_, index) => ({
    latitudeE7: Math.round((truth.latitude[index] ?? 0) * 1e7),
    longitudeE7: Math.round((truth.longitude[index] ?? 0) * 1e7),
    altitudeMm: Math.round((truth.altitude[index] ?? 0) * 1000),
  }));
  return new RouteGeometry(routePathOf(points), "barometer");
}
