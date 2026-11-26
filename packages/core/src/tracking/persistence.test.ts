import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bestEffort, lap, recording, recordingDerivation, session, settings } from "@obnixe/schema";
import type { EpochMs, Id } from "@obnixe/schema";
import { OpenSessionExistsError } from "../activity/climb.ts";
import { packSnapshot, unpackSnapshot } from "../data/backup/container.ts";
import { buildSnapshot, restorableTracks } from "../data/backup/snapshot.ts";
import { fixtures } from "../data/testFixtures.ts";
import type { Fixtures } from "../data/testFixtures.ts";
import { planTrashPurge, trashMutation } from "../data/trash.ts";
import { createTestContext, testUpgrader } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { revert } from "../undo.ts";
import { processTrack } from "./batch.ts";
import type { ProcessedTrack } from "./batch.ts";
import { encodeTrack, trackDigest } from "./codec/track.ts";
import type { Track } from "./codec/track.ts";
import { countsInRecords, maskInputsOf, recordZoneProposal, staleDerivationCount, staleDerivations, storeDerivation, zoneProposalFor } from "./derived.ts";
import {
  NotRecordableError,
  planInterruption,
  planRecompute,
  planRecordingDiscard,
  planRecordingResume,
  planRecordingSave,
  planRecordingStart,
  planTrim,
  recordingStartMutations,
  retrimmedLaps,
} from "./plans.ts";
import type { RecordingStartPlan } from "./plans.ts";
import { journalDisposition, openLiveRecording, referencedTrackFiles, trackRebuildMutations } from "./reconcile.ts";
import { coreScenarios } from "./testing/scenarios.ts";
import { profileOf, recordedLaps, untrimmed } from "./testing/run.ts";
import { toSampleColumns } from "./types.ts";
import type { TrackerMark } from "./types.ts";

let context: TestContext;
let make: Fixtures;
let track: Track;
let processed: ProcessedTrack;

const startedAt = Date.UTC(2026, 9, 24, 7, 30) as EpochMs;

beforeAll(() => {
  const scenario = coreScenarios.steadyRun(4);
  const endT = scenario.samples.at(-1)?.t ?? 0;
  const marks: readonly TrackerMark[] = [
    { kind: "start", t: 0 },
    { kind: "lap", t: Math.round(endT / 2) },
    { kind: "stop", t: endT },
  ];
  track = { startedAt, samples: toSampleColumns(scenario.samples), marks };
  processed = processTrack(track, profileOf(scenario), { laps: recordedLaps, trim: untrimmed });
});

beforeEach(() => {
  context = createTestContext();
  make = fixtures(context);
});

function start(): RecordingStartPlan {
  const plan = planRecordingStart(context.db, context.env, { sport: "run", values: {}, gearId: null, slot: null, timeZone: "Europe/Paris" });
  make.write(recordingStartMutations(plan, { startedAt, device: "Pixel 9 Pro" }));
  return plan;
}

function save(plan: RecordingStartPlan): void {
  const bytes = encodeTrack(track);
  make.write(planRecordingSave(context.db, context.env, { sessionId: plan.sessionId, track, processed, stored: { file: `tracks/${plan.recordingId}.otrk`, sha256: trackDigest(bytes), bytes: bytes.length } }));
}

const sessionOf = (id: Id) => context.db.select().from(session).where(eq(session.id, id)).get();
const recordingOf = (id: Id) => context.db.select().from(recording).where(eq(recording.sessionId, id)).get();

describe("recording start", () => {
  it("opens the session with a placeholder recording and refuses a second open session (REC-003)", () => {
    const plan = start();
    expect(sessionOf(plan.sessionId)).toMatchObject({ sport: "run", status: "in_progress", startedAt, endedAt: null, review: "pending" });
    expect(recordingOf(plan.sessionId)).toMatchObject({ source: "live", device: "Pixel 9 Pro", autoPause: true, trackFile: null, elapsedMs: 0 });
    expect(openLiveRecording(context.db)?.session.id).toBe(plan.sessionId);
    expect(() => planRecordingStart(context.db, context.env, { sport: "run", values: {}, gearId: null, slot: null, timeZone: "Europe/Paris" })).toThrow(OpenSessionExistsError);
  });

  it("refuses a sport without a recording profile", () => {
    expect(() => planRecordingStart(context.db, context.env, { sport: "strength", values: {}, gearId: null, slot: null, timeZone: "Europe/Paris" })).toThrow(NotRecordableError);
  });
});

describe("recording save", () => {
  it("completes the session with the derived values, the summary, the track and the laps (INT-030)", () => {
    const plan = start();
    save(plan);
    const saved = sessionOf(plan.sessionId);
    expect(saved).toMatchObject({ status: "completed", endedAt: startedAt + processed.elapsed.endMs, pausedSeconds: Math.round((processed.summary.elapsedMs - processed.summary.movingMs) / 1000) });
    expect(saved?.values.distance).toBe(Math.round(processed.summary.distanceMm / 1000));
    const row = recordingOf(plan.sessionId);
    expect(row).toMatchObject({ distanceMm: processed.summary.distanceMm, movingMs: processed.summary.movingMs, trackFile: `tracks/${plan.recordingId}.otrk`, energyKcal: null });
    expect(row?.previewPolyline).not.toBeNull();
    const laps = context.db.select().from(lap).where(eq(lap.sessionId, plan.sessionId)).all();
    expect(laps.map((row) => row.trigger)).toEqual(["manual", "manual"]);
    expect(laps.at(-1)?.endOffsetMs).toBe(processed.summary.elapsedMs);
  });

  it("estimates the energy with the last weigh-in before the start (CAL-003)", () => {
    make.write([{ kind: "insert", table: "weigh_in", row: { ...make.weighIn("2026-10-20", 70_000), occurredAt: (startedAt - 86_400_000) as EpochMs } }]);
    const plan = start();
    save(plan);
    expect(recordingOf(plan.sessionId)?.energyMethod).toBe("mechanical");
  });

  it("masks the preview with the zones in force, not the trashed ones (PRV-010)", () => {
    const fixes = track.samples.fixes;
    const zone = { id: context.env.newId(), label: "Maison", latitudeE7: fixes.latitudeE7[0] ?? 0, longitudeE7: fixes.longitudeE7[0] ?? 0, radiusMeters: 2000, maskScalePermille: 1000, deletedAt: null };
    const unmasked = maskInputsOf(context.db).key;
    const plain = start();
    save(plain);
    make.write([{ kind: "insert", table: "privacy_zone", row: zone }]);
    expect(maskInputsOf(context.db).key).not.toBe(unmasked);
    const masked = start();
    save(masked);
    expect(recordingOf(masked.sessionId)?.previewPolyline).not.toBe(recordingOf(plain.sessionId)?.previewPolyline);
    make.write([trashMutation("privacy_zone", zone.id, context.env.now())]);
    expect(maskInputsOf(context.db).key).toBe(unmasked);
    context.db.update(settings).set({ hideTrackEndsMeters: 200 }).run();
    expect(maskInputsOf(context.db).key).not.toBe(unmasked);
  });
});

describe("derived rows", () => {
  it("stores the eligible best efforts and stays current until a row or the masking changes (DAT-012, PR-003)", () => {
    const plan = start();
    save(plan);
    const mask = maskInputsOf(context.db);
    expect(staleDerivations(context.db, mask, 20).map((stale) => stale.session.id)).toEqual([plan.sessionId]);
    storeDerivation(context.db, plan.sessionId, track, processed, mask);
    expect(context.db.select().from(bestEffort).where(eq(bestEffort.sessionId, plan.sessionId)).all().map((row) => row.effort)).toContain("run:distance:5000");
    expect(staleDerivationCount(context.db, mask)).toBe(0);
    context.advance(1000);
    make.write([{ kind: "update", table: "session", key: plan.sessionId, patch: { title: "Footing" } }]);
    expect(staleDerivationCount(context.db, mask)).toBe(1);
    storeDerivation(context.db, plan.sessionId, track, processed, mask);
    context.db.update(settings).set({ hideTrackEndsMeters: 100 }).run();
    expect(staleDerivationCount(context.db, maskInputsOf(context.db))).toBe(1);
  });

  it("keeps simulated, poorly located and electric bike activities out of the records (PR-002)", () => {
    const row = { simulated: false, goodFixPermille: 900, pointCount: 100 };
    expect(countsInRecords(row, "run", {})).toBe(true);
    expect(countsInRecords({ ...row, simulated: true }, "run", {})).toBe(false);
    expect(countsInRecords({ ...row, goodFixPermille: 499 }, "run", {})).toBe(false);
    expect(countsInRecords({ ...row, pointCount: 0 }, "run", {})).toBe(false);
    expect(countsInRecords(row, "bike", { e_bike: true })).toBe(false);
    expect(countsInRecords(row, "bike", { e_bike: false })).toBe(true);
  });

  it("offers a recurring place once, when the saved activity starts or ends there (PRV-014)", () => {
    const point = { startLatitudeE7: 451_885_000, startLongitudeE7: 57_245_000, endLatitudeE7: 451_886_000, endLongitudeE7: 57_246_000 };
    const ids = Array.from({ length: 5 }, () => {
      const row = make.session();
      make.write([{ kind: "insert", table: "session", row }]);
      context.db
        .insert(recordingDerivation)
        .values({ sessionId: row.id, sessionUpdatedAt: context.env.now(), recordingUpdatedAt: context.env.now(), algorithmVersion: 1, maskKey: "0", ...point })
        .run();
      return row.id;
    });
    const proposal = zoneProposalFor(context.db, ids[4] as Id);
    expect(proposal).toMatchObject({ activities: 5, radiusMeters: 300 });
    if (proposal === null) throw new Error("No proposal");
    recordZoneProposal(context.db, context.env, proposal);
    expect(zoneProposalFor(context.db, ids[4] as Id)).toBeNull();
  });
});

describe("open session changes", () => {
  it("discards the open session with its recording", () => {
    const plan = start();
    make.write(planRecordingDiscard(context.db, plan.sessionId));
    expect(sessionOf(plan.sessionId)).toBeUndefined();
    expect(recordingOf(plan.sessionId)).toBeUndefined();
  });

  it("interrupts at the last journaled instant and resumes (REC-081)", () => {
    const plan = start();
    make.write(planInterruption(context.db, plan.sessionId, (startedAt + 60_000) as EpochMs));
    expect(sessionOf(plan.sessionId)).toMatchObject({ status: "interrupted", endedAt: startedAt + 60_000 });
    make.write(planRecordingResume(context.db, plan.sessionId, (startedAt + 120_000) as EpochMs));
    expect(sessionOf(plan.sessionId)).toMatchObject({ status: "in_progress", endedAt: null, pausedSeconds: 60 });
  });
});

describe("retouches", () => {
  it("rebases the stored laps on a new trim, covering the whole activity", () => {
    const laps = [
      { trigger: "manual" as const, startOffsetMs: 0, endOffsetMs: 600_000 },
      { trigger: "manual" as const, startOffsetMs: 600_000, endOffsetMs: 1_200_000 },
    ];
    expect(retrimmedLaps(laps, { startMs: 0, endMs: null }, { startMs: 100_000, endMs: 900_000 })).toEqual([
      { trigger: "manual", startOffsetMs: 0, endOffsetMs: 500_000 },
      { trigger: "manual", startOffsetMs: 500_000, endOffsetMs: Number.MAX_SAFE_INTEGER },
    ]);
  });

  it("trims the end in one undoable changeset and recomputes (SUM-004, SUM-005)", () => {
    const plan = start();
    save(plan);
    const before = recordingOf(plan.sessionId);
    const endMs = Math.round(processed.elapsed.endMs * 0.6);
    const trimmed = planTrim(context.db, context.env, plan.sessionId, track, { startMs: 0, endMs });
    const changesetId = make.write(trimmed.mutations);
    expect(recordingOf(plan.sessionId)).toMatchObject({ trimEndMs: endMs, distanceMm: trimmed.processed.summary.distanceMm });
    expect(trimmed.processed.summary.distanceMm).toBeLessThan(before?.distanceMm ?? 0);
    const laps = context.db.select().from(lap).where(eq(lap.sessionId, plan.sessionId)).all();
    expect(Math.max(...laps.map((row) => row.endOffsetMs))).toBe(endMs);
    expect(sessionOf(plan.sessionId)?.endedAt).toBe(startedAt + endMs);
    revert(context.db, context.env, { actor: { author: "user", connectionId: null }, changesetId, summary: "Annulation", restoredVersionSummary: () => "" });
    expect(recordingOf(plan.sessionId)?.distanceMm).toBe(before?.distanceMm);
    const recomputed = planRecompute(context.db, context.env, plan.sessionId, track);
    expect(recomputed.processed.summary.distanceMm).toBe(before?.distanceMm);
  });
});

describe("launch reconciliation", () => {
  it("tells orphan, open and saved journals apart and lists the referenced tracks (annex C)", () => {
    expect(journalDisposition(context.db, context.env.newId())).toEqual({ kind: "orphan" });
    const plan = start();
    expect(journalDisposition(context.db, plan.sessionId).kind).toBe("open");
    save(plan);
    const saved = journalDisposition(context.db, plan.sessionId);
    expect(saved.kind).toBe("saved");
    expect(referencedTrackFiles(context.db)).toEqual(new Set([`tracks/${plan.recordingId}.otrk`]));
    const row = recordingOf(plan.sessionId);
    if (row === undefined) throw new Error("No recording");
    make.write(trackRebuildMutations(row, { file: "tracks/rebuilt.otrk", sha256: "0".repeat(64), bytes: 1 }));
    expect(referencedTrackFiles(context.db)).toEqual(new Set(["tracks/rebuilt.otrk"]));
  });
});

describe("track files in backups and trash", () => {
  it("carries the track files and restores only those matching their row (DAT-030)", () => {
    const plan = start();
    save(plan);
    const bytes = encodeTrack(track);
    const snapshot = buildSnapshot(context.db, context.env.now(), [], [{ recordingId: plan.recordingId as Id, bytes }]);
    const unpacked = unpackSnapshot(packSnapshot(snapshot), testUpgrader);
    expect(unpacked.tracks).toEqual([{ recordingId: plan.recordingId, bytes }]);
    expect(restorableTracks(unpacked, null)).toEqual([{ recordingId: plan.recordingId, bytes }]);
    expect(restorableTracks({ ...unpacked, tracks: [{ recordingId: plan.recordingId as Id, bytes: bytes.slice(1) }] }, null)).toEqual([]);
    expect(restorableTracks(unpacked, new Set())).toEqual([]);
  });

  it("purges the track file of an expired session (INT-031)", () => {
    const plan = start();
    save(plan);
    make.write([trashMutation("session", plan.sessionId as Id, context.env.now())]);
    context.advance(31 * 86_400_000);
    expect(planTrashPurge(context.db, context.env.now()).trackFiles).toEqual([`tracks/${plan.recordingId}.otrk`]);
  });
});
