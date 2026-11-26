import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { lap, recording, session } from "@obnixe/schema";
import type { EpochMs, FieldValues, Id, SportKey } from "@obnixe/schema";
import { fixtures } from "../data/testFixtures.ts";
import type { Fixtures } from "../data/testFixtures.ts";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { encodeTrack, trackDigest } from "./codec/track.ts";
import type { Track } from "./codec/track.ts";
import { LiveTracker } from "./live.ts";
import { planRecordingDiscard, planRecordingSave, planRecordingStart, recordingProfileOf, recordingStartMutations, reprocessRecording, StopwatchGuidanceError, liveRecordingOf } from "./plans.ts";
import type { RecordingStartPlan } from "./plans.ts";
import { resolveProfile, stopwatchProfile } from "./profile.ts";
import type { ResolvedProfile } from "./profile.ts";
import { staleDerivations } from "./derived.ts";
import { activePrivacyMask } from "./privacyZones.ts";
import { journalDisposition, openLiveRecording } from "./reconcile.ts";
import { processStopwatch } from "./stopwatch.ts";
import { toSampleColumns } from "./types.ts";
import type { Sample, TrackerMark } from "./types.ts";

const startedAt = Date.UTC(2026, 10, 27, 7, 0) as EpochMs;
const minute = 60_000;

function profileFor(sport: SportKey, values: FieldValues): ResolvedProfile {
  const profile = stopwatchProfile(sport, values);
  if (profile === null) throw new Error(`${sport} records nothing`);
  return profile;
}

const heartRate = (fromMs: number, toMs: number, bpm: number): readonly Sample[] =>
  Array.from({ length: Math.floor((toMs - fromMs) / 1000) + 1 }, (_, index): Sample => ({ type: "heart_rate", t: fromMs + index * 1000, bpm, contact: "contact", rrInterval: null }));

const marks: readonly TrackerMark[] = [
  { kind: "start", t: 0 },
  { kind: "pause", t: 10 * minute },
  { kind: "resume", t: 12 * minute },
  { kind: "lap", t: 15 * minute },
  { kind: "stop", t: 30 * minute },
];

const indoorTrack: Track = { startedAt, samples: toSampleColumns([...heartRate(0, 10 * minute, 120), ...heartRate(12 * minute, 30 * minute, 150)]), marks };

describe("stopwatch profile (REC-060)", () => {
  it("records the options without a track and keeps the pace unit and splits of the sport", () => {
    expect(resolveProfile("swim", { water: "pool" })).toBeNull();
    expect(resolveProfile("bike", { kind: "indoor" })).toBeNull();
    const pool = profileFor("swim", { water: "pool" });
    expect(pool).toMatchObject({ stopwatch: true, autoPauseDefault: false, pacePerMeters: 100, splitMeters: 100, recordedValues: {} });
    expect(pool.metrics).not.toContain("heart_rate");
    expect(pool.readout).toEqual({ main: "moving", secondary: ["elapsed", "clock"] });
    const indoor = profileFor("bike", { kind: "indoor" });
    expect(indoor.readout.secondary).toContain("heart_rate");
    expect(indoor.metrics).not.toContain("distance");
    expect(stopwatchProfile("strength", {})).toBeNull();
  });

  it("counts the time between the marks live, without positions", () => {
    const live = new LiveTracker(profileFor("run", {}), null);
    live.mark({ kind: "start", t: 0 });
    for (const sample of heartRate(0, 5 * minute, 140)) live.push(sample);
    live.mark({ kind: "pause", t: 5 * minute });
    expect(live.snapshot(7 * minute)).toMatchObject({ movingMs: 5 * minute, elapsedMs: 7 * minute, distanceMm: 0 });
    live.mark({ kind: "resume", t: 7 * minute });
    live.mark({ kind: "lap", t: 9 * minute });
    const snapshot = live.snapshot(10 * minute);
    expect(snapshot.movingMs).toBe(8 * minute);
    expect(snapshot.metrics.moving).toBe(8 * minute);
    expect(snapshot.metrics.distance).toBeUndefined();
    expect(live.laps).toEqual([{ index: 0, startMs: 0, elapsedMs: 9 * minute, movingMs: 7 * minute, distanceMm: 0 }]);
    expect(snapshot.lap.movingMs).toBe(minute);
  });

  it("measures the moving time without the pauses, the heart rate over it, the typed distance and the manual laps", () => {
    const processed = processStopwatch(indoorTrack, profileFor("bike", { kind: "indoor" }), 12_000_000);
    expect(processed.summary).toMatchObject({ elapsedMs: 30 * minute, movingMs: 28 * minute, distanceMm: 12_000_000, heartRateMax: 150, heartRateSource: "sensor", pointCount: 0 });
    expect(processed.summary.heartRateAvg).toBe(Math.round((120 * 10 + 150 * 18) / 28));
    expect(processed.moving).toEqual([
      { startMs: 0, endMs: 10 * minute },
      { startMs: 12 * minute, endMs: 30 * minute },
    ]);
    expect(processed.laps.map((summary) => ({ ...summary.bounds, movingMs: summary.movingMs, heartRateAvg: summary.heartRateAvg }))).toEqual([
      { trigger: "manual", startOffsetMs: 0, endOffsetMs: 15 * minute, workoutStep: null, movingMs: 13 * minute, heartRateAvg: Math.round((120 * 10 + 150 * 3) / 13) },
      { trigger: "manual", startOffsetMs: 15 * minute, endOffsetMs: 30 * minute, workoutStep: null, movingMs: 15 * minute, heartRateAvg: 150 },
    ]);
  });
});

describe("stopwatch recording (REC-060)", () => {
  let context: TestContext;
  let make: Fixtures;

  beforeEach(() => {
    context = createTestContext();
    make = fixtures(context);
  });

  function start(sport: SportKey, values: FieldValues): RecordingStartPlan {
    const plan = planRecordingStart(context.db, context.env, { sport, values, gearId: null, slot: null, timeZone: "Europe/Paris", routeId: null, workout: null, stopwatch: true });
    make.write(recordingStartMutations(plan, { startedAt, device: "Pixel 9 Pro" }));
    return plan;
  }

  function save(plan: RecordingStartPlan, track: Track, distanceMm: number): void {
    const bytes = encodeTrack(track);
    const processed = processStopwatch(track, recordingProfileOf(liveRecordingOf(context.db, plan.sessionId)), distanceMm);
    make.write(planRecordingSave(context.db, context.env, { sessionId: plan.sessionId, track, processed, stored: { file: `tracks/${plan.recordingId}.otrk`, sha256: trackDigest(bytes), bytes: bytes.length }, pains: [] }));
  }

  const sessionOf = (id: Id) => context.db.select().from(session).where(eq(session.id, id)).get();
  const recordingOf = (id: Id) => context.db.select().from(recording).where(eq(recording.sessionId, id)).get();

  it("opens a pool swim without location, recovered and reconciled like a live recording", () => {
    const plan = start("swim", { water: "pool", pool_length: 25 });
    expect(plan.settings.autoPause).toBe(false);
    expect(recordingOf(plan.sessionId)).toMatchObject({ source: "stopwatch", autoPause: false });
    expect(openLiveRecording(context.db)?.session.id).toBe(plan.sessionId);
    expect(journalDisposition(context.db, plan.sessionId).kind).toBe("open");
    expect(recordingProfileOf(liveRecordingOf(context.db, plan.sessionId))).toMatchObject({ stopwatch: true, pacePerMeters: 100 });
  });

  it("saves the time, the typed distance and the laps of an indoor ride", () => {
    const plan = start("bike", { kind: "indoor" });
    save(plan, indoorTrack, 12_000_000);
    expect(sessionOf(plan.sessionId)).toMatchObject({ status: "completed", endedAt: startedAt + 30 * minute, pausedSeconds: 120 });
    expect(sessionOf(plan.sessionId)?.values).toMatchObject({ kind: "indoor", distance: 12_000, heart_rate_avg: Math.round((120 * 10 + 150 * 18) / 28) });
    expect(recordingOf(plan.sessionId)).toMatchObject({ source: "stopwatch", movingMs: 28 * minute, distanceMm: 12_000_000, pointCount: 0, previewPolyline: null });
    expect(context.db.select().from(lap).where(eq(lap.sessionId, plan.sessionId)).all()).toHaveLength(2);
  });

  it("keeps its time and typed distance when rebuilt, with the stopwatch profile of a sport without GPS", () => {
    const plan = start("swim", { water: "pool", pool_length: 25 });
    save(plan, indoorTrack, 1_500_000);
    const stale = staleDerivations(context.db, activePrivacyMask(context.db), 10).find((row) => row.session.id === plan.sessionId);
    if (stale === undefined) throw new Error("Not stale");
    const processed = reprocessRecording(context.db, stale, indoorTrack, { startMs: stale.recording.trimStartMs, endMs: stale.recording.trimEndMs }, recordingProfileOf(stale));
    expect(processed.summary).toMatchObject({ movingMs: 28 * minute, distanceMm: 1_500_000, heartRateAvg: null, heartRateSource: "none" });
    expect(processed.laps).toHaveLength(2);
  });

  it("leaves the distance out when none was typed, and discards like a live recording", () => {
    const plan = start("swim", { water: "pool" });
    save(plan, { startedAt, samples: toSampleColumns([]), marks: [{ kind: "start", t: 0 }, { kind: "stop", t: 40 * minute }] }, 0);
    expect(sessionOf(plan.sessionId)?.values).toEqual({ water: "pool" });
    expect(recordingOf(plan.sessionId)).toMatchObject({ movingMs: 40 * minute, heartRateAvg: null });
    const other = start("run", {});
    make.write(planRecordingDiscard(context.db, other.sessionId));
    expect(sessionOf(other.sessionId)).toBeUndefined();
  });

  it("follows neither a route nor a workout", () => {
    const request = { sport: "run" as const, values: {}, gearId: null, slot: null, timeZone: "Europe/Paris", workout: null, stopwatch: true };
    expect(() => planRecordingStart(context.db, context.env, { ...request, routeId: context.env.newId() })).toThrow(StopwatchGuidanceError);
  });
});
