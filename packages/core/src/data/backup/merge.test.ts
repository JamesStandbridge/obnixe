import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  change,
  changeset,
  checkIn,
  exercise,
  measurement,
  measurementKind,
  painReport,
  program,
  programVersion,
  rotationSkip,
  session,
  settings,
  sportPreference,
  strengthEntry,
  strengthSet,
  weighIn,
  zoneTracking,
} from "@obnixe/schema";
import type { Id, LocalDate } from "@obnixe/schema";
import { currentProgram } from "../../rotation.ts";
import { createTestContext } from "../../testing.ts";
import type { TestContext } from "../../testing.ts";
import { revert } from "../../undo.ts";
import { fixtures } from "../testFixtures.ts";
import type { Fixtures } from "../testFixtures.ts";
import { mergeSnapshot, planMerge } from "./merge.ts";
import { replaceWithSnapshot } from "./replace.ts";
import { buildSnapshot } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";

let local: TestContext;
let remote: TestContext;
let here: Fixtures;
let there: Fixtures;

beforeEach(() => {
  local = createTestContext();
  remote = createTestContext();
  here = fixtures(local);
  there = fixtures(remote);
});

function snapshotOf(context: TestContext): Snapshot {
  return buildSnapshot(context.db, context.env.now());
}

function copyLocalToRemote(): void {
  replaceWithSnapshot(remote.db, remote.env, snapshotOf(local));
}

function later(ms = 60_000): void {
  local.advance(ms);
  remote.advance(ms);
}

describe("newest", () => {
  it("inserts unknown rows and keeps both sides", () => {
    here.write([{ kind: "insert", table: "session", row: here.session({ sport: "run", values: { distance: 8000 } }) }]);
    there.write([{ kind: "insert", table: "session", row: there.session({ sport: "swim", values: { distance: 1500 } }) }]);
    const result = mergeSnapshot(local.db, local.env, snapshotOf(remote));
    expect(result.counts.inserted).toBe(1);
    expect(local.db.select({ sport: session.sport }).from(session).orderBy(asc(session.sport)).all()).toEqual([{ sport: "run" }, { sport: "swim" }]);
  });

  it("takes the newer version with its owned rows and drops the replaced ones", () => {
    const bench = here.exercise("Développé couché");
    const workout = here.session();
    const kept = here.entry(workout.id, bench.id, 0);
    const dropped = here.entry(workout.id, bench.id, 1);
    here.write([
      { kind: "insert", table: "exercise", row: bench },
      { kind: "insert", table: "session", row: workout },
      { kind: "insert", table: "strength_entry", row: kept },
      { kind: "insert", table: "strength_entry", row: dropped },
      { kind: "insert", table: "strength_set", row: here.set(kept.id, 0, 8) },
      { kind: "insert", table: "strength_set", row: here.set(dropped.id, 0, 5) },
    ]);
    copyLocalToRemote();
    later();
    const extraSet = there.set(kept.id, 1, 6);
    there.write([
      { kind: "update", table: "session", key: workout.id, patch: { note: "Bonne séance" } },
      { kind: "delete", table: "strength_set", key: remote.db.select().from(strengthSet).where(eq(strengthSet.entryId, dropped.id)).get()?.id as string },
      { kind: "delete", table: "strength_entry", key: dropped.id },
      { kind: "insert", table: "strength_set", row: extraSet },
    ]);
    mergeSnapshot(local.db, local.env, snapshotOf(remote));
    expect(local.db.select({ note: session.note }).from(session).get()).toEqual({ note: "Bonne séance" });
    expect(local.db.select({ id: strengthEntry.id }).from(strengthEntry).all()).toEqual([{ id: kept.id }]);
    expect(local.db.select({ reps: strengthSet.reps }).from(strengthSet).orderBy(asc(strengthSet.position)).all()).toEqual([{ reps: 8 }, { reps: 6 }]);
  });

  it("keeps the local version and its owned rows when it is newer", () => {
    const workout = here.session();
    here.write([{ kind: "insert", table: "session", row: workout }]);
    copyLocalToRemote();
    later();
    there.write([{ kind: "update", table: "session", key: workout.id, patch: { note: "Ancienne" } }]);
    later();
    here.write([{ kind: "update", table: "session", key: workout.id, patch: { note: "Récente" } }]);
    expect(planMerge(local.db, snapshotOf(remote)).mutations).toHaveLength(0);
    expect(local.db.select({ note: session.note }).from(session).get()).toEqual({ note: "Récente" });
  });

  it("archives an incoming active program when another one is active here", () => {
    const mine = here.program("active");
    here.write([{ kind: "insert", table: "program", row: mine }]);
    const theirs = there.program("active");
    there.write([{ kind: "insert", table: "program", row: theirs }]);
    mergeSnapshot(local.db, local.env, snapshotOf(remote));
    expect(local.db.select({ id: program.id, status: program.status }).from(program).where(eq(program.id, theirs.id)).get()).toEqual({ id: theirs.id, status: "archived" });
    expect(local.db.select({ status: program.status }).from(program).where(eq(program.id, mine.id)).get()).toEqual({ status: "active" });
  });

  it("closes an incoming open session when one is already open here", () => {
    here.write([{ kind: "insert", table: "session", row: here.session({ status: "in_progress", endedAt: null }) }]);
    const theirs = there.session({ status: "in_progress", endedAt: null });
    there.write([{ kind: "insert", table: "session", row: theirs }]);
    mergeSnapshot(local.db, local.env, snapshotOf(remote));
    expect(local.db.select({ status: session.status }).from(session).where(eq(session.id, theirs.id)).get()).toEqual({ status: "completed" });
  });

  it("ends an incoming open zone tracking that collides", () => {
    here.write([{ kind: "insert", table: "zone_tracking", row: { id: local.env.newId(), zone: "knee_right", reason: "user", painReportId: null, startedAt: local.env.now(), endedAt: null } }]);
    later();
    const theirs = remote.env.newId();
    there.write([{ kind: "insert", table: "zone_tracking", row: { id: theirs, zone: "knee_right", reason: "user", painReportId: null, startedAt: remote.env.now(), endedAt: null } }]);
    mergeSnapshot(local.db, local.env, snapshotOf(remote));
    const open = local.db.select().from(zoneTracking).all().filter((row) => row.endedAt === null);
    expect(open).toHaveLength(1);
    expect(local.db.select({ endedAt: zoneTracking.endedAt }).from(zoneTracking).where(eq(zoneTracking.id, theirs)).get()?.endedAt).toBe(remote.env.now());
  });

  it("resolves sport preferences by their sport key", () => {
    here.write([{ kind: "insert", table: "sport_preference", row: { sport: "run", enabled: true, position: 0 } }]);
    later();
    there.write([{ kind: "insert", table: "sport_preference", row: { sport: "run", enabled: false, position: 3 } }]);
    mergeSnapshot(local.db, local.env, snapshotOf(remote));
    expect(local.db.select({ enabled: sportPreference.enabled }).from(sportPreference).all()).toEqual([{ enabled: false }]);
  });
});

describe("immutable", () => {
  it("adds unknown skips and never rewrites known ones", () => {
    const mine = here.program("active");
    here.write([{ kind: "insert", table: "program", row: mine }]);
    const skip = { id: local.env.newId(), programId: mine.id, slotLineageId: "slot-a" as Id, skippedAt: local.env.now(), localDate: "2026-10-24" as LocalDate };
    here.write([{ kind: "insert", table: "rotation_skip", row: skip }]);
    copyLocalToRemote();
    const incoming = snapshotOf(remote);
    const altered: Snapshot = {
      ...incoming,
      tables: {
        ...incoming.tables,
        rotation_skip: [
          ...incoming.tables.rotation_skip.map((row) => ({ ...row, slotLineageId: "slot-b" as Id })),
          { ...skip, id: remote.env.newId(), localDate: "2026-10-25" as LocalDate },
        ],
      },
    };
    mergeSnapshot(local.db, local.env, altered);
    expect(local.db.select({ lineage: rotationSkip.slotLineageId, day: rotationSkip.localDate }).from(rotationSkip).orderBy(asc(rotationSkip.localDate)).all()).toEqual([
      { lineage: "slot-a", day: "2026-10-24" },
      { lineage: "slot-a", day: "2026-10-25" },
    ]);
  });
});

describe("natural_key", () => {
  it("maps an exercise with the same name onto the local one", () => {
    const mine = here.exercise("Squat");
    here.write([{ kind: "insert", table: "exercise", row: mine }]);
    const theirs = there.exercise("squat");
    const workout = there.session();
    there.write([
      { kind: "insert", table: "exercise", row: theirs },
      { kind: "insert", table: "session", row: workout },
      { kind: "insert", table: "strength_entry", row: there.entry(workout.id, theirs.id, 0) },
      { kind: "insert", table: "exercise_zone", row: { exerciseId: theirs.id, zone: "knee_left" } },
    ]);
    mergeSnapshot(local.db, local.env, snapshotOf(remote));
    expect(local.db.select({ id: exercise.id }).from(exercise).all()).toEqual([{ id: mine.id }]);
    expect(local.db.select({ exerciseId: strengthEntry.exerciseId }).from(strengthEntry).get()).toEqual({ exerciseId: mine.id });
  });

  it("matches measurement kinds case-insensitively and remaps their measurements", () => {
    const mine = { id: local.env.newId(), label: "Tour de taille", zone: null, position: 0, archivedAt: null };
    here.write([{ kind: "insert", table: "measurement_kind", row: mine }]);
    const theirs = { id: remote.env.newId(), label: "tour de taille", zone: null, position: 0, archivedAt: null };
    there.write([
      { kind: "insert", table: "measurement_kind", row: theirs },
      { kind: "insert", table: "measurement", row: { id: remote.env.newId(), kindId: theirs.id, occurredAt: remote.env.now(), localDate: "2026-10-20" as LocalDate, timeZone: "Europe/Paris", millimeters: 812, deletedAt: null } },
    ]);
    mergeSnapshot(local.db, local.env, snapshotOf(remote));
    expect(local.db.select().from(measurementKind).all()).toHaveLength(1);
    expect(local.db.select({ kindId: measurement.kindId }).from(measurement).get()).toEqual({ kindId: mine.id });
  });
});

describe("day_singleton", () => {
  it("keeps one weigh-in per day, the most recent one", () => {
    const mine = here.weighIn("2026-10-24", 72400);
    here.write([{ kind: "insert", table: "weigh_in", row: mine }]);
    later();
    there.write([{ kind: "insert", table: "weigh_in", row: there.weighIn("2026-10-24", 71900) }]);
    mergeSnapshot(local.db, local.env, snapshotOf(remote));
    expect(local.db.select({ id: weighIn.id, grams: weighIn.grams }).from(weighIn).all()).toEqual([{ id: mine.id, grams: 71900 }]);
  });

  it("ignores an older value for the same day", () => {
    there.write([{ kind: "insert", table: "weigh_in", row: there.weighIn("2026-10-24", 71900) }]);
    later();
    here.write([{ kind: "insert", table: "weigh_in", row: here.weighIn("2026-10-24", 72400) }]);
    expect(planMerge(local.db, snapshotOf(remote)).mutations).toHaveLength(0);
  });

  it("brings the winning check-in's pain reports along", () => {
    const mine = here.checkIn("2026-10-24", 2);
    here.write([
      { kind: "insert", table: "check_in", row: mine },
      { kind: "insert", table: "pain_report", row: { id: local.env.newId(), zone: "lower_back", level: "stop", occurredAt: local.env.now(), localDate: "2026-10-24" as LocalDate, timeZone: "Europe/Paris", sessionId: null, phase: null, strengthSetId: null, sessionItemId: null, checkInId: mine.id, note: null, deletedAt: null } },
    ]);
    later();
    const theirs = there.checkIn("2026-10-24", 4);
    there.write([
      { kind: "insert", table: "check_in", row: theirs },
      { kind: "insert", table: "pain_report", row: { id: remote.env.newId(), zone: "knee_right", level: "discomfort", occurredAt: remote.env.now(), localDate: "2026-10-24" as LocalDate, timeZone: "Europe/Paris", sessionId: null, phase: null, strengthSetId: null, sessionItemId: null, checkInId: theirs.id, note: null, deletedAt: null } },
    ]);
    mergeSnapshot(local.db, local.env, snapshotOf(remote));
    expect(local.db.select({ id: checkIn.id, energy: checkIn.energy }).from(checkIn).all()).toEqual([{ id: mine.id, energy: 4 }]);
    expect(local.db.select({ zone: painReport.zone, checkInId: painReport.checkInId }).from(painReport).all()).toEqual([{ zone: "knee_right", checkInId: mine.id }]);
  });
});

describe("owned", () => {
  it("releases references to owned rows that are dropped", () => {
    const workout = here.session();
    const report = { id: local.env.newId(), zone: "knee_right" as const, level: "discomfort" as const, occurredAt: local.env.now(), localDate: "2026-10-24" as LocalDate, timeZone: "Europe/Paris", sessionId: workout.id, phase: "end" as const, strengthSetId: null, sessionItemId: null, checkInId: null, note: null, deletedAt: null };
    here.write([
      { kind: "insert", table: "session", row: workout },
      { kind: "insert", table: "pain_report", row: report },
    ]);
    copyLocalToRemote();
    later();
    here.write([{ kind: "insert", table: "zone_tracking", row: { id: local.env.newId(), zone: "knee_right", reason: "pain_reported", painReportId: report.id, startedAt: local.env.now(), endedAt: null } }]);
    later();
    there.write([
      { kind: "delete", table: "pain_report", key: report.id },
      { kind: "update", table: "session", key: workout.id, patch: { note: "Sans douleur" } },
    ]);
    mergeSnapshot(local.db, local.env, snapshotOf(remote));
    expect(local.db.select().from(painReport).all()).toHaveLength(0);
    expect(local.db.select({ painReportId: zoneTracking.painReportId }).from(zoneTracking).get()).toEqual({ painReportId: null });
  });
});

describe("renumber", () => {
  it("interleaves program versions by creation time", () => {
    const shared = here.program("active");
    const first = here.version(shared.id, 1, "Base");
    here.write([
      { kind: "insert", table: "program", row: shared },
      { kind: "insert", table: "program_version", row: first },
    ]);
    copyLocalToRemote();
    later();
    const theirs = there.version(shared.id, 2, "Force");
    there.write([{ kind: "insert", table: "program_version", row: theirs }]);
    later();
    const mine = here.version(shared.id, 2, "Volume");
    here.write([{ kind: "insert", table: "program_version", row: mine }]);
    mergeSnapshot(local.db, local.env, snapshotOf(remote));
    expect(local.db.select({ name: programVersion.name, number: programVersion.number }).from(programVersion).orderBy(asc(programVersion.number)).all()).toEqual([
      { name: "Base", number: 1 },
      { name: "Force", number: 2 },
      { name: "Volume", number: 3 },
    ]);
    expect(currentProgram(local.db)?.version.name).toBe("Volume");
  });
});

describe("merge changeset", () => {
  it("is a single import changeset that can be undone", () => {
    here.write([{ kind: "insert", table: "weigh_in", row: here.weighIn("2026-10-23", 72000) }]);
    there.write([
      { kind: "insert", table: "weigh_in", row: there.weighIn("2026-10-24", 71900) },
      { kind: "insert", table: "session", row: there.session() },
    ]);
    const result = mergeSnapshot(local.db, local.env, snapshotOf(remote));
    const changesetId = result.changesetId as Id;
    expect(local.db.select({ author: changeset.author }).from(changeset).where(eq(changeset.id, changesetId)).get()).toEqual({ author: "import" });
    expect(local.db.select().from(change).where(eq(change.changesetId, changesetId)).all()).toHaveLength(2);
    revert(local.db, local.env, { actor: { author: "user", connectionId: null }, changesetId, summary: "Annulation", restoredVersionSummary: (number) => `v${number}` });
    expect(local.db.select().from(session).all()).toHaveLength(0);
    expect(local.db.select({ day: weighIn.localDate }).from(weighIn).all()).toEqual([{ day: "2026-10-23" }]);
  });

  it("is idempotent", () => {
    there.write([{ kind: "insert", table: "session", row: there.session() }]);
    const incoming = snapshotOf(remote);
    mergeSnapshot(local.db, local.env, incoming);
    later();
    const second = mergeSnapshot(local.db, local.env, incoming);
    expect(second.changesetId).toBeNull();
    expect(second.counts).toEqual({ inserted: 0, updated: 0, deleted: 0 });
  });

  it("takes newer settings", () => {
    later();
    remote.db.update(settings).set({ theme: "sunlight", massUnit: "lb", updatedAt: remote.env.now() }).run();
    mergeSnapshot(local.db, local.env, snapshotOf(remote));
    expect(local.db.select({ theme: settings.theme, massUnit: settings.massUnit }).from(settings).get()).toEqual({ theme: "sunlight", massUnit: "lb" });
  });
});

describe("replace", () => {
  it("wipes local rows and loads the snapshot in one go", () => {
    here.write([{ kind: "insert", table: "session", row: here.session({ sport: "run" }) }]);
    const shared = there.program("active");
    const base = there.version(shared.id, 1, "Base");
    const aliasId = remote.env.newId();
    const bench = there.exercise("Développé couché");
    const alias = { ...there.exercise("Développé"), id: aliasId, mergedIntoId: bench.id, archivedAt: remote.env.now() };
    there.write([
      { kind: "insert", table: "program", row: shared },
      { kind: "insert", table: "program_version", row: base },
      { kind: "insert", table: "exercise", row: bench },
      { kind: "insert", table: "exercise", row: alias },
    ]);
    expect(snapshotOf(remote).tables.exercise.map((row) => row.id)).toEqual([aliasId, bench.id]);
    remote.db.update(settings).set({ theme: "system" }).run();
    const changesetId = replaceWithSnapshot(local.db, local.env, snapshotOf(remote));
    expect(local.db.select().from(session).all()).toHaveLength(0);
    expect(local.db.select({ id: exercise.id }).from(exercise).all()).toHaveLength(2);
    expect(local.db.select({ changesetId: programVersion.changesetId }).from(programVersion).get()).toEqual({ changesetId });
    expect(local.db.select({ theme: settings.theme }).from(settings).get()).toEqual({ theme: "system" });
    expect(currentProgram(local.db)?.program.id).toBe(shared.id);
  });
});
