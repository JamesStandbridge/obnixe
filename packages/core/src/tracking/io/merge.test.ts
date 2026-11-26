import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lap, recording, session } from "@obnixe/schema";
import type { EpochMs, Id } from "@obnixe/schema";
import { fixtures } from "../../data/testFixtures.ts";
import { createTestContext } from "../../testing.ts";
import type { TestContext } from "../../testing.ts";
import { revert } from "../../undo.ts";
import { commit } from "../../writer.ts";
import { processTrack } from "../batch.ts";
import { decodeTrack, encodeTrack, trackDigest } from "../codec/track.ts";
import type { Track } from "../codec/track.ts";
import { planRecordingSave, planRecordingStart, recordingStartMutations } from "../plans.ts";
import { coreScenarios } from "../testing/scenarios.ts";
import { profileOf, recordedLaps, untrimmed } from "../testing/run.ts";
import { absentValue, toSampleColumns } from "../types.ts";
import type { Fix } from "../types.ts";
import { computeImport, findImportDuplicate } from "./import.ts";
import type { ImportComputation } from "./import.ts";
import { findImportMerge, NothingToMergeError, planImportMerge } from "./merge.ts";
import { readActivityFile } from "./zip.ts";

const startedAt = Date.UTC(2026, 9, 24, 7, 30) as EpochMs;
const watchAltitudeMeters = 500;
const watchBpm = 141;

let context: TestContext;
let phoneTrack: Track;
let phoneFixes: readonly Fix[];

beforeAll(() => {
  const scenario = coreScenarios.steadyRun(4);
  const samples = scenario.samples.filter((sample) => sample.type !== "heart_rate");
  phoneFixes = samples.filter((sample): sample is Fix => sample.type === "fix");
  phoneTrack = { startedAt, samples: toSampleColumns(samples), marks: [{ kind: "start", t: 0 }, { kind: "stop", t: samples.at(-1)?.t ?? 0 }] };
});

beforeEach(() => {
  context = createTestContext();
  fixtures(context);
});

function recordPhone(track: Track = phoneTrack): Id {
  const plan = planRecordingStart(context.db, context.env, { sport: "run", values: {}, gearId: null, slot: null, timeZone: "Europe/Paris", routeId: null, workout: null, stopwatch: false });
  commit(context.db, context.env, { actor: { author: "user", connectionId: null }, summary: "Sortie démarrée", revertsId: null, mutations: recordingStartMutations(plan, { startedAt, device: "Pixel 9 Pro" }) });
  const processed = processTrack(track, profileOf({ sport: "run" }), { laps: recordedLaps, trim: untrimmed });
  const bytes = encodeTrack(track);
  const mutations = planRecordingSave(context.db, context.env, { sessionId: plan.sessionId, track, processed, stored: { file: `tracks/${plan.recordingId}.otrk`, sha256: trackDigest(bytes), bytes: bytes.length }, pains: [] });
  commit(context.db, context.env, { actor: { author: "user", connectionId: null }, summary: "Sortie", revertsId: null, mutations });
  return plan.sessionId;
}

/** A watch file of the same outing: every other phone position, from 5 s before the phone start, with heart rate and its own altitude. */
function watchFile(coverage = 1): ImportComputation {
  const kept = phoneFixes.filter((_, index) => index % 2 === 0).slice(0, Math.round((phoneFixes.length / 2) * coverage));
  const point = (fix: Fix, time: number): string =>
    `<trkpt lat="${(fix.latitudeE7 / 1e7).toFixed(7)}" lon="${(fix.longitudeE7 / 1e7).toFixed(7)}"><ele>${watchAltitudeMeters}</ele><time>${new Date(time).toISOString()}</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${watchBpm}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>`;
  const first = kept[0];
  if (first === undefined) throw new Error("No fix");
  const points = [point(first, startedAt - 5000), ...kept.map((fix) => point(fix, startedAt + fix.t))];
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="Garmin Connect" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk><type>running</type><trkseg>${points.join("")}</trkseg></trk></gpx>`;
  return computeImport(readActivityFile(new TextEncoder().encode(gpx)), { sport: "run", values: {} });
}

const recordingOf = (sessionId: Id) => context.db.select().from(recording).where(eq(recording.sessionId, sessionId)).get();

describe("phone and watch merge (IO-052)", () => {
  it("offers the phone recording covered by the file, not one it only half covers", () => {
    const sessionId = recordPhone();
    expect(findImportMerge(context.db, watchFile())).toEqual({ sessionId, trackFile: recordingOf(sessionId)?.trackFile, addsHeartRate: true, offersAltitude: true });
    expect(findImportMerge(context.db, watchFile(0.5))).toBeNull();
  });

  it("adds the watch heart rate and altitude to a new track and recording, undoable to the original", () => {
    const sessionId = recordPhone();
    const before = recordingOf(sessionId);
    const values = context.db.select({ values: session.values }).from(session).where(eq(session.id, sessionId)).get()?.values;
    const computation = watchFile();
    const merge = findImportMerge(context.db, computation);
    if (merge === null || before === undefined) throw new Error("No merge");
    const plan = planImportMerge(context.db, context.env, { computation, merge, phoneTrack, replaceAltitude: true });
    const changesetId = commit(context.db, context.env, plan.request);

    const after = recordingOf(sessionId);
    expect(after).toMatchObject({ id: plan.recordingId, source: "live", device: "Pixel 9 Pro", trackFile: `tracks/${plan.recordingId}.otrk`, trackSha256: plan.track.sha256, heartRateSource: "file", heartRateDevice: "Fichier GPX", elevationSource: "file", externalId: computation.activity.externalId });
    expect(after?.heartRateAvg).toBe(watchBpm);
    expect(after?.distanceMm).toBe(before.distanceMm);
    expect(after?.altitudeMinMm).toBeGreaterThan((watchAltitudeMeters - 5) * 1000);
    expect(after?.altitudeMaxMm).toBeLessThan((watchAltitudeMeters + 5) * 1000);
    expect(context.db.select().from(lap).where(eq(lap.sessionId, sessionId)).all()).toHaveLength(1);
    const merged = decodeTrack(plan.track.bytes);
    expect(merged.samples.fixes.length).toBe(phoneTrack.samples.fixes.length);
    expect(merged.samples.pressure.length).toBe(0);
    expect(merged.samples.fixes.altitudeMslMm[10]).toBe(watchAltitudeMeters * 1000);
    expect(merged.samples.fixes.altitudeEllipsoidMm[10]).toBe(absentValue);
    expect(merged.samples.heartRate.t[0]).toBe(0);
    expect(context.db.select({ values: session.values }).from(session).where(eq(session.id, sessionId)).get()?.values).toMatchObject({ ...values, heart_rate_avg: watchBpm });
    expect(findImportDuplicate(context.db, computation)).toEqual({ kind: "already_imported", sessionId });

    revert(context.db, context.env, { actor: { author: "user", connectionId: null }, changesetId, summary: "Annulation", restoredVersionSummary: (number) => `v${number}` });
    expect(recordingOf(sessionId)).toMatchObject({ id: before.id, trackFile: before.trackFile, trackSha256: before.trackSha256, heartRateSource: "none", externalId: null });
  });

  it("keeps the phone altitude unless asked, and refuses a merge adding nothing", () => {
    const sessionId = recordPhone();
    const elevationSource = recordingOf(sessionId)?.elevationSource;
    const computation = watchFile();
    const merge = findImportMerge(context.db, computation);
    if (merge === null) throw new Error("No merge");
    const plan = planImportMerge(context.db, context.env, { computation, merge, phoneTrack, replaceAltitude: false });
    commit(context.db, context.env, plan.request);
    expect(recordingOf(sessionId)).toMatchObject({ heartRateSource: "file", elevationSource });
    const merged = decodeTrack(plan.track.bytes);
    expect(merged.samples.fixes.altitudeMslMm).toEqual(phoneTrack.samples.fixes.altitudeMslMm);
    expect(() => planImportMerge(context.db, context.env, { computation, merge, phoneTrack: merged, replaceAltitude: false })).toThrow(NothingToMergeError);
  });
});
