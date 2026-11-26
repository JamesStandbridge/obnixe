import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { segment, segmentDerivation, segmentEffort } from "@obnixe/schema";
import type { EpochMs, Id, Segment } from "@obnixe/schema";
import { packSnapshot, unpackSnapshot } from "../data/backup/container.ts";
import { replaceWithSnapshot } from "../data/backup/replace.ts";
import { buildSnapshot } from "../data/backup/snapshot.ts";
import { fixtures } from "../data/testFixtures.ts";
import type { Fixtures } from "../data/testFixtures.ts";
import { planTrashPurge, purgeExpiredTrash, restoreBlocker, trashItems, trashMutation } from "../data/trash.ts";
import { createTestContext, testUpgrader } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { processTrack } from "./batch.ts";
import type { ProcessedTrack } from "./batch.ts";
import { encodeTrack, trackDigest } from "./codec/track.ts";
import type { Track } from "./codec/track.ts";
import { storeDerivation, storeSweptEfforts } from "./derived.ts";
import { planRecordingSave, planRecordingStart, recordingStartMutations } from "./plans.ts";
import { activePrivacyMask } from "./privacyZones.ts";
import { segmentBoard, segmentSummaries, segmentTrend, sessionSegmentEfforts } from "./segmentBoards.ts";
import { clearSegmentEfforts, markSegmentsSwept, segmentShapesNear, segmentSweepCandidates, staleSegments } from "./segmentRows.ts";
import { newSegment, renameSegment, segmentShape } from "./segments.ts";
import { locate } from "./stages/derive.ts";
import { coreScenarios } from "./testing/scenarios.ts";
import { profileOf, recordedLaps, untrimmed } from "./testing/run.ts";
import { toSampleColumns } from "./types.ts";

let context: TestContext;
let make: Fixtures;
let track: Track;
let processed: ProcessedTrack;

const startedAt = Date.UTC(2026, 9, 24, 7, 30) as EpochMs;

beforeAll(() => {
  const scenario = coreScenarios.steadyRun(4);
  const endT = scenario.samples.at(-1)?.t ?? 0;
  track = { startedAt, samples: toSampleColumns(scenario.samples), marks: [{ kind: "start", t: 0 }, { kind: "stop", t: endT }] };
  processed = processTrack(track, profileOf(scenario), { laps: recordedLaps, trim: untrimmed });
});

beforeEach(() => {
  context = createTestContext();
  make = fixtures(context);
});

function saved(sport: "run" | "bike" = "run"): Id {
  const plan = planRecordingStart(context.db, context.env, { sport, values: {}, gearId: null, slot: null, timeZone: "Europe/Paris", routeId: null, workout: null, stopwatch: false });
  make.write(recordingStartMutations(plan, { startedAt: context.env.now(), device: "Pixel 9 Pro" }));
  const bytes = encodeTrack(track);
  make.write(planRecordingSave(context.db, context.env, { sessionId: plan.sessionId, track, processed, stored: { file: `tracks/${plan.recordingId}.otrk`, sha256: trackDigest(bytes), bytes: bytes.length }, pains: [] }));
  context.advance(86_400_000);
  return plan.sessionId as Id;
}

function derive(sessionId: Id): void {
  storeDerivation(context.db, sessionId, track, processed, activePrivacyMask(context.db));
}

/** A segment over the first kilometer of the second leg of the steady run, drawn from `sessionId`. */
function created(sessionId: Id): Segment {
  const range = { from: locate(processed.series.distance, 2700), to: locate(processed.series.distance, 3700) };
  const plan = newSegment(context.env, processed.series, processed.summary.ascentMm !== null, { name: "Quai", sport: "run", sessionId, range });
  make.write([plan.mutation]);
  const row = context.db.select().from(segment).where(eq(segment.id, plan.segmentId)).get();
  if (row === undefined) throw new Error("No segment");
  return row;
}

function sweep(): void {
  const stale = staleSegments(context.db);
  const shapes = stale.map(segmentShape);
  clearSegmentEfforts(
    context.db,
    stale.map((row) => row.id),
  );
  for (const candidate of segmentSweepCandidates(context.db, shapes)) storeSweptEfforts(context.db, candidate.session.id, processed, shapes);
  markSegmentsSwept(context.db, stale);
}

const effortsOf = (segmentId: Id) => context.db.select().from(segmentEffort).where(eq(segmentEffort.segmentId, segmentId)).all();

function insertEffort(segmentId: Id, sessionId: Id, elapsedMs: number): void {
  context.db.insert(segmentEffort).values({ segmentId, sessionId, occurrence: 0, startOffsetMs: 60_000, elapsedMs, movingMs: elapsedMs, heartRateAvg: null, algorithmVersion: 1 }).run();
}

describe("segment efforts (SEG-002, SEG-003)", () => {
  it("matches a derived activity against the segments of its family near it", () => {
    const source = saved();
    const row = created(source);
    expect(segmentShapesNear(context.db, "trail", processed.summary.bbox).map((shape) => shape.id)).toEqual([row.id]);
    expect(segmentShapesNear(context.db, "bike", processed.summary.bbox)).toEqual([]);
    derive(source);
    expect(effortsOf(row.id)).toMatchObject([{ sessionId: source, occurrence: 0 }]);
    const bike = saved("bike");
    derive(bike);
    expect(effortsOf(row.id)).toHaveLength(1);
  });

  it("sweeps the whole history once per geometry, not on a rename", () => {
    const first = saved();
    const second = saved();
    derive(first);
    derive(second);
    const row = created(first);
    expect(staleSegments(context.db).map((stale) => stale.id)).toEqual([row.id]);
    expect(segmentSweepCandidates(context.db, [segmentShape(row)]).map((candidate) => candidate.session.id)).toEqual([first, second]);
    sweep();
    expect(effortsOf(row.id).map((effort) => effort.sessionId)).toEqual([first, second]);
    expect(staleSegments(context.db)).toEqual([]);
    const rename = renameSegment(row, "Quai Perrière");
    if (rename === null) throw new Error("No rename");
    make.write([rename]);
    expect(staleSegments(context.db)).toEqual([]);
    make.write([{ kind: "update", table: "segment", key: row.id, patch: { distanceMm: row.distanceMm * 2 } }]);
    expect(staleSegments(context.db).map((stale) => stale.id)).toEqual([row.id]);
    sweep();
    expect(effortsOf(row.id)).toEqual([]);
  });

  it("does not mark a segment swept when its geometry changed meanwhile", () => {
    const row = created(saved());
    const stale = staleSegments(context.db);
    make.write([{ kind: "update", table: "segment", key: row.id, patch: { distanceMm: row.distanceMm + 1000 } }]);
    markSegmentsSwept(context.db, stale);
    expect(context.db.select().from(segmentDerivation).all()).toEqual([]);
  });

  it("ranks the efforts in force with the best, the last, the count and the trend", () => {
    const row = created(saved());
    const times = [400_000, 380_000, 390_000, 360_000, 350_000, 355_000];
    const sessions = times.map((elapsedMs, index) => {
      const at = (startedAt + index * 86_400_000) as EpochMs;
      const sessionRow = make.session({ sport: "run", startedAt: at, endedAt: at });
      make.write([{ kind: "insert", table: "session", row: sessionRow }]);
      insertEffort(row.id, sessionRow.id, elapsedMs);
      return sessionRow.id;
    });
    const board = segmentBoard(context.db, row.id);
    expect(board).toMatchObject({ count: 6, best: { sessionId: sessions[4], elapsedMs: 350_000 }, last: { sessionId: sessions[5] }, trend: "faster" });
    expect(board?.ranked.map((entry) => entry.elapsedMs)).toEqual([...times].sort((left, right) => left - right));
    expect(sessionSegmentEfforts(context.db, sessions[5] as Id)).toMatchObject([{ segment: { id: row.id }, rank: 2, count: 6, bestElapsedMs: 350_000, elapsedMs: 355_000 }]);
    make.write([trashMutation("session", sessions[4] as Id, context.env.now())]);
    expect(segmentBoard(context.db, row.id)).toMatchObject({ count: 5, best: { sessionId: sessions[5] } });
    expect(segmentSummaries(context.db, "foot")).toMatchObject([{ segment: { id: row.id }, count: 5 }]);
    make.write([trashMutation("segment", row.id, context.env.now())]);
    expect(segmentSummaries(context.db, "foot")).toEqual([]);
    expect(sessionSegmentEfforts(context.db, sessions[5] as Id)).toEqual([]);
  });

  it("follows the recent efforts against the ones before", () => {
    expect(segmentTrend([])).toBeNull();
    expect(segmentTrend([{ elapsedMs: 100 }])).toBeNull();
    expect(segmentTrend([{ elapsedMs: 100 }, { elapsedMs: 101 }])).toBe("steady");
    expect(segmentTrend([{ elapsedMs: 100 }, { elapsedMs: 110 }])).toBe("slower");
    expect(segmentTrend([100, 100, 100, 100, 95, 95, 95].map((elapsedMs) => ({ elapsedMs })))).toBe("faster");
  });
});

describe("segments in trash and backups", () => {
  it("restores a trashed segment and purges it with its efforts", () => {
    const source = saved();
    const row = created(source);
    derive(source);
    make.write([trashMutation("segment", row.id, context.env.now())]);
    const item = trashItems(context.db).find((candidate) => candidate.table === "segment");
    expect(item?.row.id).toBe(row.id);
    if (item === undefined) throw new Error("No trash item");
    expect(restoreBlocker(context.db, item)).toBeNull();
    context.advance(31 * 86_400_000);
    purgeExpiredTrash(context.db, context.env);
    expect(context.db.select().from(segment).all()).toEqual([]);
    expect(effortsOf(row.id)).toEqual([]);
  });

  it("keeps a segment when the activity it was drawn from is purged", () => {
    const source = saved();
    const row = created(source);
    make.write([trashMutation("session", source, context.env.now())]);
    context.advance(31 * 86_400_000);
    expect(planTrashPurge(context.db, context.env.now()).releases).toEqual([{ table: "segment", id: row.id, patch: { sourceSessionId: null } }]);
    purgeExpiredTrash(context.db, context.env);
    expect(context.db.select().from(segment).where(eq(segment.id, row.id)).get()?.sourceSessionId).toBeNull();
  });

  it("carries segments in backups and searches them again after a restore", () => {
    const source = saved();
    const row = created(source);
    derive(source);
    sweep();
    const snapshot = unpackSnapshot(packSnapshot(buildSnapshot(context.db, context.env.now())), testUpgrader);
    expect(snapshot.tables.segment).toMatchObject([{ id: row.id, name: "Quai", sourceSessionId: source }]);
    replaceWithSnapshot(context.db, context.env, snapshot);
    expect(effortsOf(row.id)).toEqual([]);
    expect(staleSegments(context.db).map((stale) => stale.id)).toEqual([row.id]);
  });
});
