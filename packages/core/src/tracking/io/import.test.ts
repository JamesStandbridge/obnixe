import { readFileSync } from "node:fs";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { changeset, lap, recording, session } from "@obnixe/schema";
import type { EpochMs, Id } from "@obnixe/schema";
import { fixtures } from "../../data/testFixtures.ts";
import type { Fixtures } from "../../data/testFixtures.ts";
import { trashMutation } from "../../data/trash.ts";
import { updateSettings } from "../../settings.ts";
import { createTestContext } from "../../testing.ts";
import type { TestContext } from "../../testing.ts";
import { commit } from "../../writer.ts";
import { decodeTrack } from "../codec/track.ts";
import { decodePolyline } from "../codec/polyline.ts";
import { countsInRecords, recordsMinGoodFixPermille } from "../derived.ts";
import { newPrivacyZone } from "../privacyZones.ts";
import type { ImportedActivity } from "./activity.ts";
import { AlreadyImportedError, computeImport, findImportDuplicate, planImport, ReplacedSessionNotFoundError } from "./import.ts";
import type { ImportComputation, ImportPlan } from "./import.ts";
import { readActivityFile } from "./zip.ts";

const fixtureDirectory = new URL("../../../test/fixtures/import/", import.meta.url);
const activityOf = (name: string): ImportedActivity => readActivityFile(new Uint8Array(readFileSync(new URL(name, fixtureDirectory))));

function computed(name: string): ImportComputation {
  const activity = activityOf(name);
  if (activity.sport === null) throw new Error(`${name} has no sport`);
  return computeImport(activity, activity.sport);
}

let context: TestContext;
let make: Fixtures;

beforeEach(() => {
  context = createTestContext();
  make = fixtures(context);
});

function importFile(computation: ImportComputation, replaceSessionId: Id | null = null): ImportPlan {
  const plan = planImport(context.db, context.env, { computation, timeZone: "Europe/Paris", replaceSessionId });
  commit(context.db, context.env, plan.request);
  return plan;
}

describe("computeImport (IO-011, IO-050)", () => {
  it("measures a Venu 3S run with the engine, within 1 % of the watch distance", () => {
    const computation = computed("venu3s-run.fit");
    const { summary } = computation;
    expect(computation.processed).not.toBeNull();
    expect(Math.abs(summary.distanceMm - 1_688_750) / 1_688_750).toBeLessThan(0.01);
    expect(summary.elapsedMs).toBe(618_000);
    expect(summary.movingMs).toBeLessThanOrEqual(543_000);
    expect(summary.movingMs).toBeGreaterThan(530_000);
    expect(summary).toMatchObject({ elevationSource: "file", cadenceSource: "file", heartRateSource: "file", pointCount: 140 });
    expect(summary.cadenceAvg).toBeGreaterThan(160);
    expect(summary.cadenceAvg).toBeLessThan(180);
    expect(computation.laps).toEqual([
      { trigger: "import", startOffsetMs: 0, endOffsetMs: 451_000, workoutStep: null },
      { trigger: "import", startOffsetMs: 451_000, endOffsetMs: 618_000, workoutStep: null },
    ]);
    expect(computation.pausedSeconds).toBe(Math.round((summary.elapsedMs - summary.movingMs) / 1000));
    expect(computation.values).toEqual({ distance: Math.round(summary.distanceMm / 1000), elevation_gain: Math.round((summary.ascentMm ?? 0) / 1000), heart_rate_avg: summary.heartRateAvg });
  });

  it("keeps the file totals of a pool swim and a treadmill run, which have no positions", () => {
    const swim = computed("venu3s-pool-swim.fit");
    expect(swim.processed).toBeNull();
    expect(swim.values).toEqual({ water: "pool", distance: 1000, pool_length: 25, lengths: 40 });
    expect(swim.summary).toMatchObject({ distanceMm: 1_000_000, movingMs: 1_326_000, heartRateAvg: 139, heartRateMax: 151, heartRateSource: "file", pointCount: 0, bbox: null });
    expect(swim.laps).toHaveLength(4);
    const treadmill = computed("venu3s-treadmill.fit");
    expect(treadmill.processed).toBeNull();
    expect(treadmill.summary).toMatchObject({ distanceMm: 1_750_000, movingMs: 600_000, heartRateAvg: 146, cadenceSource: "file" });
    expect(treadmill.summary.steps).toBeGreaterThan(1600);
    expect(treadmill.values).toEqual({ distance: 1750, heart_rate_avg: 146 });
  });

  it("cuts a GPX at its track boundaries and keeps one lap for the whole activity", () => {
    const walk = computed("multi-track.gpx");
    expect(walk.summary.elapsedMs).toBe(834_000);
    expect(walk.summary.movingMs).toBeLessThanOrEqual(234_000);
    expect(walk.pausedSeconds).toBeGreaterThanOrEqual(600);
    expect(walk.summary.elevationSource).toBe("none");
    expect(walk.laps).toEqual([{ trigger: "import", startOffsetMs: 0, endOffsetMs: 834_000, workoutStep: null }]);
  });

  it("measures the sport the user picks instead of the detected one", () => {
    const activity = activityOf("komoot-hike.gpx");
    expect(activity.sport).toBeNull();
    const hike = computeImport(activity, { sport: "hike", values: { kind: "trail" } });
    expect(hike.values.kind).toBe("trail");
    expect(hike.summary.ascentMm).not.toBeNull();
  });
});

describe("planImport (IO-010)", () => {
  it("writes a completed session, its recording, laps and trace in one import changeset", () => {
    make.write([{ kind: "insert", table: "weigh_in", row: make.weighIn("2026-10-24", 70_000) }]);
    updateSettings(context.db, { birthYear: 1990, sex: "female" }, context.env.now());
    const computation = computed("venu3s-run.fit");
    const plan = importFile(computation);
    const row = context.db.select().from(session).where(eq(session.id, plan.sessionId)).get();
    expect(row).toMatchObject({ sport: "run", status: "completed", review: "pending", startedAt: computation.activity.startedAt, endedAt: computation.activity.startedAt + 618_000, localDate: "2026-11-20", values: computation.values });
    const stored = context.db.select().from(recording).where(eq(recording.id, plan.recordingId)).get();
    expect(stored).toMatchObject({
      source: "import",
      importFormat: "fit",
      externalId: "fit:1:4261:3456789012:1164092310",
      device: "Garmin Venu 3S",
      heartRateDevice: "Garmin Venu 3S",
      autoPause: false,
      distanceMm: computation.summary.distanceMm,
      energyMethod: "heart_rate",
      importedEnergyKcal: 61,
      trackFile: `tracks/${plan.recordingId}.otrk`,
    });
    expect(stored?.previewPolyline).not.toBeNull();
    expect(plan.track?.sha256).toBe(bytesToHex(sha256(plan.track?.bytes ?? new Uint8Array())));
    expect(stored?.trackSha256).toBe(plan.track?.sha256);
    expect(stored?.trackBytes).toBe(plan.track?.bytes.length);
    expect(decodeTrack(plan.track?.bytes ?? new Uint8Array())).toEqual(computation.track);
    const laps = context.db.select().from(lap).where(eq(lap.sessionId, plan.sessionId)).all();
    expect(laps.map((row) => [row.position, row.trigger, row.startOffsetMs, row.endOffsetMs])).toEqual([
      [0, "import", 0, 451_000],
      [1, "import", 451_000, 618_000],
    ]);
    expect(context.db.select({ author: changeset.author }).from(changeset).all().at(-1)).toEqual({ author: "import" });
  });

  it("makes positioned files without accuracies count in records, and pool swims not (PR-002, PR-003)", () => {
    const eligible = (computation: ImportComputation): boolean => {
      const plan = importFile(computation);
      const row = context.db.select().from(recording).where(eq(recording.id, plan.recordingId)).get();
      if (row === undefined) throw new Error("No recording");
      return countsInRecords(row, computation.sport.sport, computation.values);
    };
    for (const name of ["venu3s-run.fit", "garmin-connect-run.gpx", "strava-ride.gpx", "garmin-run.tcx"]) {
      const computation = computed(name);
      expect(computation.summary.goodFixPermille, name).toBeGreaterThanOrEqual(recordsMinGoodFixPermille);
      expect(eligible(computation), name).toBe(true);
    }
    expect(eligible(computeImport(activityOf("komoot-hike.gpx"), { sport: "hike", values: {} }))).toBe(true);
    expect(eligible(computed("venu3s-pool-swim.fit"))).toBe(false);
  });

  it("imports a pool swim, which records no track, as a swim session with the file values", () => {
    const plan = importFile(computed("venu3s-pool-swim.fit"));
    expect(context.db.select({ values: session.values }).from(session).where(eq(session.id, plan.sessionId)).get()?.values).toEqual({ water: "pool", distance: 1000, pool_length: 25, lengths: 40 });
    expect(context.db.select().from(recording).where(eq(recording.id, plan.recordingId)).get()).toMatchObject({ energyKcal: null, energyMethod: null, previewPolyline: null, bbox: null, elevationSource: "none" });
  });

  it("masks the preview with the zones outside the trash only (PRV-010)", () => {
    const computation = computed("garmin-connect-run.gpx");
    const start = computation.activity.points[0];
    const zone = newPrivacyZone(context.env, { label: "Maison", center: { latitude: (start?.latitudeE7 ?? 0) / 1e7, longitude: (start?.longitudeE7 ?? 0) / 1e7 }, radiusMeters: 200 }, 1000);
    make.write([zone.mutation]);
    const masked = planImport(context.db, context.env, { computation, timeZone: "Europe/Paris", replaceSessionId: null });
    make.write([trashMutation("privacy_zone", zone.zoneId, context.env.now())]);
    const open = planImport(context.db, context.env, { computation, timeZone: "Europe/Paris", replaceSessionId: null });
    const previewOf = (plan: ImportPlan): string | null => {
      const insert = plan.request.mutations.find((mutation) => mutation.kind === "insert" && mutation.table === "recording");
      return insert?.kind === "insert" && insert.table === "recording" ? (insert.row.previewPolyline ?? null) : null;
    };
    const first = (preview: string | null) => decodePolyline(preview ?? "", 5).latitudeE7[0];
    expect(Math.abs((first(previewOf(masked)) ?? 0) - (start?.latitudeE7 ?? 0))).toBeGreaterThan(10_000);
    expect(Math.abs((first(previewOf(open)) ?? 0) - (start?.latitudeE7 ?? 0))).toBeLessThan(100);
  });
});

describe("duplicates (IO-012, DAT-031)", () => {
  it("flags a session of the same sport starting within 120 s with a distance within 5 %", () => {
    const computation = computed("venu3s-run.fit");
    const startedAt = (computation.activity.startedAt + 90_000) as EpochMs;
    const distance = Math.round(computation.summary.distanceMm / 1000);
    const near = make.session({ sport: "run", startedAt, endedAt: (startedAt + 600_000) as EpochMs, values: { distance: Math.round(distance * 1.04) } });
    const far = make.session({ sport: "run", startedAt, endedAt: (startedAt + 600_000) as EpochMs, values: { distance: Math.round(distance * 1.2) } });
    const other = make.session({ sport: "walk", startedAt, endedAt: (startedAt + 600_000) as EpochMs, values: { distance } });
    make.write([near, far, other].map((row) => ({ kind: "insert", table: "session", row })));
    expect(findImportDuplicate(context.db, computation)).toEqual({ kind: "probable", sessionIds: [near.id] });
    const plan = importFile(computation, near.id);
    expect(context.db.select({ deletedAt: session.deletedAt }).from(session).where(eq(session.id, near.id)).get()?.deletedAt).not.toBeNull();
    expect(findImportDuplicate(context.db, computation)).toEqual({ kind: "already_imported", sessionId: plan.sessionId });
  });

  it("refuses the same file twice unless it replaces its session, and takes the file back from the trash", () => {
    const computation = computed("venu3s-run.fit");
    const first = importFile(computation);
    expect(() => planImport(context.db, context.env, { computation, timeZone: "Europe/Paris", replaceSessionId: null })).toThrow(AlreadyImportedError);
    const second = importFile(computation, first.sessionId);
    expect(context.db.select({ externalId: recording.externalId }).from(recording).where(eq(recording.id, first.recordingId)).get()).toEqual({ externalId: null });
    make.write([trashMutation("session", second.sessionId, context.env.now())]);
    expect(findImportDuplicate(context.db, computation)).toEqual({ kind: "none" });
    const third = importFile(computation);
    expect(context.db.select({ externalId: recording.externalId }).from(recording).where(eq(recording.id, third.recordingId)).get()).toEqual({ externalId: computation.activity.externalId });
    expect(() => planImport(context.db, context.env, { computation, timeZone: "Europe/Paris", replaceSessionId: second.sessionId })).toThrow(ReplacedSessionNotFoundError);
  });
});
