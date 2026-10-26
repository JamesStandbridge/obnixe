import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { agentCall, agentConnection, backup, change, changeset, journaledTables, sportKeys, painReport, session, sportPreference, strengthEntry, strengthSet, weighIn, zoneTracking } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate, SportPreference } from "@obnixe/schema";
import { loadRevertIndex } from "../agent/history.ts";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { sessionHistory } from "../training/report.ts";
import { ChangesetNotFoundError, RevertConflictError, revert } from "../undo.ts";
import type { RevertRequest } from "../undo.ts";
import { commit } from "../writer.ts";
import { isFirstLaunch, launchCounts } from "./firstLaunch.ts";
import { foreignKeys } from "./foreignKeys.ts";
import { remindersCalendar, toggleWeekday, weekdaysOf, EmptyReminderError } from "./reminders.ts";
import { SportLockedError, initialSportMutations, lockedSports, moveSportMutations, setSportEnabledMutations, sportChoices } from "./sports.ts";
import { fixtures } from "./testFixtures.ts";
import type { Fixtures } from "./testFixtures.ts";
import { expiredReplacedSnapshots, planTrashPurge, purgeExpiredTrash, restoreBlocker, restoreMutation, trashItems, trashRetentionMs } from "./trash.ts";

let context: TestContext;
let make: Fixtures;

beforeEach(() => {
  context = createTestContext();
  make = fixtures(context);
});

const day = 86_400_000;

const revertRequest = (changesetId: Id): RevertRequest => ({ actor: { author: "user", connectionId: null }, changesetId, summary: "Annulation", restoredVersionSummary: (number) => `v${number}` });

describe("foreign keys", () => {
  it("follow the journaled table order", () => {
    const order = new Map(journaledTables.map((table, index) => [table, index]));
    for (const key of foreignKeys) {
      if (key.target === key.table) continue;
      expect((order.get(key.target) ?? 0) < (order.get(key.table) ?? 0), `${key.table}.${key.column} -> ${key.target}`).toBe(true);
    }
  });
});

describe("first launch", () => {
  it("needs neither sport preferences nor sessions", () => {
    expect(isFirstLaunch(launchCounts(context.db))).toBe(true);
    make.write(initialSportMutations(sportKeys, new Set(["run"])));
    expect(isFirstLaunch(launchCounts(context.db))).toBe(false);
    expect(isFirstLaunch({ sportPreferences: 0, sessions: 3 })).toBe(false);
  });
});

describe("sports", () => {
  const preferences = (): SportPreference[] => context.db.select().from(sportPreference).all();

  it("records every catalog sport with the chosen ones first", () => {
    make.write(initialSportMutations(["strength", "run", "climb", "hike", "swim", "bike"], new Set(["climb", "strength"])));
    expect(sportChoices(preferences()).map((choice) => [choice.sport, choice.enabled])).toEqual([
      ["strength", true],
      ["climb", true],
      ["run", false],
      ["hike", false],
      ["swim", false],
      ["bike", false],
      ["yoga", false],
    ]);
  });

  it("lists unknown sports as disabled when nothing is recorded", () => {
    expect(sportChoices([]).every((choice) => !choice.enabled && !choice.persisted)).toBe(true);
    make.write(setSportEnabledMutations([], "bike", true, new Set()));
    expect(sportChoices(preferences())[0]).toMatchObject({ sport: "bike", enabled: true, persisted: true });
  });

  it("appends a newly enabled sport after the enabled ones", () => {
    make.write(initialSportMutations(sportKeys, new Set(["strength", "run"])));
    make.write(setSportEnabledMutations(preferences(), "yoga", true, new Set()));
    expect(sportChoices(preferences()).slice(0, 3).map((choice) => choice.sport)).toEqual(["strength", "run", "yoga"]);
    make.write(setSportEnabledMutations(preferences(), "strength", false, new Set()));
    expect(sportChoices(preferences()).slice(0, 2).map((choice) => choice.sport)).toEqual(["run", "yoga"]);
  });

  it("refuses to hide a sport the active program uses", () => {
    const active = make.program("active");
    const version = make.version(active.id, 1, "Base");
    make.write([
      { kind: "insert", table: "program", row: active },
      { kind: "insert", table: "program_version", row: version },
      { kind: "insert", table: "program_slot", row: { id: context.env.newId(), versionId: version.id, lineageId: "a" as Id, position: 0, sport: "strength", name: "A", targetDurationSeconds: null, targetEffort: null, targetValues: {} } },
    ]);
    const locked = lockedSports(context.db);
    expect([...locked]).toEqual(["strength"]);
    make.write(initialSportMutations(sportKeys, new Set(["strength", "run"])));
    expect(() => setSportEnabledMutations(preferences(), "strength", false, locked)).toThrow(SportLockedError);
    expect(setSportEnabledMutations(preferences(), "run", false, locked)).toEqual([{ kind: "update", table: "sport_preference", key: "run", patch: { enabled: false, position: 1 } }]);
  });

  it("moves enabled sports within the enabled ones", () => {
    make.write(initialSportMutations(sportKeys, new Set(["strength", "run", "climb"])));
    make.write(moveSportMutations(preferences(), "climb", -1));
    expect(sportChoices(preferences()).slice(0, 3).map((choice) => choice.sport)).toEqual(["strength", "climb", "run"]);
    expect(moveSportMutations(preferences(), "strength", -1)).toEqual([]);
    expect(moveSportMutations(preferences(), "run", 1)).toEqual([]);
  });
});

describe("trash", () => {
  function trashedWorkout(deletedAt: EpochMs, zone: "shoulder_right" | "shoulder_left" = "shoulder_right"): Id {
    const bench = make.exercise(`Développé ${deletedAt}`);
    const workout = make.session({ deletedAt });
    const entry = make.entry(workout.id, bench.id, 0);
    const set = make.set(entry.id, 0, 8);
    const report = { id: context.env.newId(), zone, level: "discomfort" as const, occurredAt: context.env.now(), localDate: "2026-10-24" as LocalDate, timeZone: "Europe/Paris", sessionId: workout.id, phase: "during" as const, strengthSetId: set.id, sessionItemId: null, checkInId: null, note: null, deletedAt: null };
    make.write([
      { kind: "insert", table: "exercise", row: bench },
      { kind: "insert", table: "session", row: workout },
      { kind: "insert", table: "strength_entry", row: entry },
      { kind: "insert", table: "strength_set", row: set },
      { kind: "insert", table: "pain_report", row: report },
      { kind: "insert", table: "zone_tracking", row: { id: context.env.newId(), zone, reason: "pain_reported", painReportId: report.id, startedAt: context.env.now(), endedAt: null } },
    ]);
    return workout.id;
  }

  it("lists trashed rows newest first with their expiry", () => {
    const deletedAt = context.env.now();
    trashedWorkout(deletedAt);
    context.advance(day);
    make.write([{ kind: "insert", table: "weigh_in", row: { ...make.weighIn("2026-10-20", 72000), deletedAt: context.env.now() } }]);
    const items = trashItems(context.db);
    expect(items.map((item) => item.table)).toEqual(["weigh_in", "session"]);
    expect(items[1]?.expiresAt).toBe(deletedAt + trashRetentionMs);
  });

  it("purges rows past 30 days with everything they own", () => {
    const old = trashedWorkout(context.env.now());
    context.advance(10 * day);
    const recent = trashedWorkout(context.env.now(), "shoulder_left");
    context.advance(21 * day);
    const result = purgeExpiredTrash(context.db, context.env);
    expect(result.purgedRows).toBe(4);
    expect(context.db.select({ id: session.id }).from(session).all()).toEqual([{ id: recent }]);
    expect(context.db.select().from(strengthEntry).where(eq(strengthEntry.sessionId, old)).all()).toHaveLength(0);
    expect(context.db.select().from(strengthSet).all()).toHaveLength(1);
    expect(context.db.select().from(painReport).all()).toHaveLength(1);
    expect(context.db.select({ painReportId: zoneTracking.painReportId }).from(zoneTracking).orderBy(asc(zoneTracking.startedAt)).all()[0]).toEqual({ painReportId: null });
    expect(planTrashPurge(context.db, context.env.now()).deletions).toHaveLength(0);
  });

  it("forgets the journal history of purged rows and is not itself journaled", () => {
    const workout = make.session();
    const created = make.write([{ kind: "insert", table: "session", row: workout }]);
    const edited = make.write([{ kind: "update", table: "session", key: workout.id, patch: { note: "Lourd" } }]);
    const weight = make.weighIn("2026-10-20", 72000);
    make.write([{ kind: "insert", table: "weigh_in", row: weight }]);
    const mixed = make.write([
      { kind: "update", table: "weigh_in", key: weight.id, patch: { grams: 71500 } },
      { kind: "update", table: "session", key: workout.id, patch: { note: "Très lourd" } },
    ]);
    const trashed = make.write([{ kind: "update", table: "session", key: workout.id, patch: { deletedAt: context.env.now() } }]);
    context.advance(31 * day);
    const before = context.db.select({ id: changeset.id }).from(changeset).all().length;
    purgeExpiredTrash(context.db, context.env);
    expect(context.db.select().from(change).where(and(eq(change.tableName, "session"), eq(change.rowId, workout.id))).all()).toHaveLength(0);
    const remaining = context.db.select({ id: changeset.id }).from(changeset).all().map((row) => row.id);
    expect(remaining).toHaveLength(before - 3);
    expect(remaining).toContain(mixed);
    for (const gone of [created, edited, trashed]) expect(remaining).not.toContain(gone);
    expect(() => revert(context.db, context.env, revertRequest(edited))).toThrow(ChangesetNotFoundError);
    revert(context.db, context.env, revertRequest(mixed));
    expect(context.db.select({ grams: weighIn.grams, deletedAt: weighIn.deletedAt }).from(weighIn).all()).toEqual([{ grams: 72000, deletedAt: null }]);
    expect(context.db.select().from(session).all()).toHaveLength(0);
  });

  it("makes surviving changes on released rows conflict instead of resurrecting references", () => {
    const old = trashedWorkout(context.env.now());
    const created = context.db.select({ changesetId: change.changesetId }).from(change).where(and(eq(change.tableName, "session"), eq(change.rowId, old))).get()?.changesetId as Id;
    context.advance(31 * day);
    purgeExpiredTrash(context.db, context.env);
    expect(context.db.select({ table: change.tableName }).from(change).where(eq(change.changesetId, created)).orderBy(asc(change.sequence)).all()).toEqual([{ table: "exercise" }, { table: "zone_tracking" }]);
    expect(() => revert(context.db, context.env, revertRequest(created))).toThrow(RevertConflictError);
    expect(context.db.select().from(session).all()).toHaveLength(0);
  });

  it("keeps the history of a live session consistent when one of its pain reports is purged", () => {
    const workout = make.session();
    const report = { id: context.env.newId(), zone: "knee_left" as const, level: "discomfort" as const, occurredAt: context.env.now(), localDate: "2026-10-24" as LocalDate, timeZone: "Europe/Paris", sessionId: workout.id, phase: "end" as const, strengthSetId: null, sessionItemId: null, checkInId: null, note: null, deletedAt: null };
    const created = make.write([
      { kind: "insert", table: "session", row: workout },
      { kind: "insert", table: "pain_report", row: report },
    ]);
    context.advance(60_000);
    const noted = make.write([{ kind: "update", table: "session", key: workout.id, patch: { note: "Genou" } }]);
    context.advance(60_000);
    make.write([{ kind: "update", table: "pain_report", key: report.id, patch: { deletedAt: context.env.now() } }]);
    context.advance(31 * day);
    purgeExpiredTrash(context.db, context.env);
    const history = sessionHistory(context.db, workout.id);
    expect(history.map((entry) => entry.changesetId)).toEqual([created, noted]);
    expect(history.map((entry) => entry.revertible)).toEqual([false, true]);
    revert(context.db, context.env, revertRequest(noted));
    expect(context.db.select({ note: session.note }).from(session).get()).toEqual({ note: null });
  });

  it("detaches agent calls whose changeset is forgotten", () => {
    const connectionId = context.env.newId();
    context.db.insert(agentConnection).values({ id: connectionId, client: "Claude", host: "mac", canReadBody: true, canWrite: true, canReadPhotos: false, startedAt: context.env.now() }).run();
    const workout = make.session({ deletedAt: context.env.now() });
    const written = commit(context.db, context.env, { actor: { author: "agent", connectionId }, summary: "Séance ajoutée", revertsId: null, mutations: [{ kind: "insert", table: "session", row: workout }] });
    const callId = context.env.newId();
    context.db.insert(agentCall).values({ id: callId, connectionId, tool: "log_session", kind: "write", summary: "Séance ajoutée", changesetId: written, calledAt: context.env.now() }).run();
    context.advance(31 * day);
    purgeExpiredTrash(context.db, context.env);
    expect(context.db.select({ changesetId: agentCall.changesetId, summary: agentCall.summary }).from(agentCall).where(eq(agentCall.id, callId)).get()).toEqual({ changesetId: null, summary: "Séance ajoutée" });
    expect(loadRevertIndex(context.db).size).toBe(0);
  });

  it("returns the photo files to delete", () => {
    make.write([
      {
        kind: "insert",
        table: "photo",
        row: { id: context.env.newId(), pose: "front", occurredAt: context.env.now(), localDate: "2026-10-01" as LocalDate, timeZone: "Europe/Paris", file: "photos/a.jpg", sha256: "ab", width: 10, height: 10, deletedAt: context.env.now() },
      },
    ]);
    context.advance(31 * day);
    expect(purgeExpiredTrash(context.db, context.env).photoFiles).toEqual(["photos/a.jpg"]);
  });

  it("blocks restoring a day that already has a value", () => {
    const trashed = { ...make.weighIn("2026-10-20", 72000), deletedAt: context.env.now() };
    make.write([{ kind: "insert", table: "weigh_in", row: trashed }]);
    const [item] = trashItems(context.db);
    if (item === undefined) throw new Error("missing trash item");
    expect(restoreBlocker(context.db, item)).toBeNull();
    make.write([{ kind: "insert", table: "weigh_in", row: make.weighIn("2026-10-20", 71000) }]);
    expect(restoreBlocker(context.db, item)).toBe("day_taken");
  });

  it("restores through a journaled update", () => {
    make.write([{ kind: "insert", table: "weigh_in", row: { ...make.weighIn("2026-10-20", 72000), deletedAt: context.env.now() } }]);
    const [item] = trashItems(context.db);
    if (item === undefined) throw new Error("missing trash item");
    make.write([restoreMutation(item)]);
    expect(context.db.select({ deletedAt: weighIn.deletedAt }).from(weighIn).get()).toEqual({ deletedAt: null });
  });

  it("expires replaced data snapshots after 30 days", () => {
    context.db.insert(backup).values({ id: context.env.newId(), kind: "import_replace", schemaVersion: 1, catalogVersion: 1, includesPhotos: false, sizeBytes: 10, coveredFrom: null, coveredTo: null, snapshotFile: "replaced.bin", createdAt: context.env.now() }).run();
    expect(expiredReplacedSnapshots(context.db, context.env.now())).toHaveLength(0);
    context.advance(31 * day);
    expect(expiredReplacedSnapshots(context.db, context.env.now()).map((row) => row.snapshotFile)).toEqual(["replaced.bin"]);
  });
});

describe("reminders", () => {
  it("toggles weekdays in the mask", () => {
    const mask = toggleWeekday(toggleWeekday(0, 0), 4);
    expect(weekdaysOf(mask)).toEqual([0, 4]);
    expect(weekdaysOf(toggleWeekday(mask, 0))).toEqual([4]);
  });

  it("builds a weekly calendar event starting on the next chosen day", () => {
    const calendar = remindersCalendar({ weekdays: (1 << 2) | (1 << 4), minutes: 18 * 60 + 30, from: "2026-10-26" as LocalDate, now: Date.UTC(2026, 9, 26, 8, 0) as EpochMs, uid: "abc", title: "Séance, Obnixe" });
    const lines = calendar.split("\r\n");
    expect(lines).toContain("DTSTART:20261028T183000");
    expect(lines).toContain("RRULE:FREQ=WEEKLY;BYDAY=WE,FR");
    expect(lines).toContain("SUMMARY:Séance\\, Obnixe");
    expect(lines).toContain("DTSTAMP:20261026T080000Z");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
  });

  it("starts today when today is chosen", () => {
    expect(remindersCalendar({ weekdays: 1, minutes: 7 * 60, from: "2026-10-26" as LocalDate, now: 0 as EpochMs, uid: "x", title: "Séance" })).toContain("DTSTART:20261026T070000");
  });

  it("needs a weekday", () => {
    expect(() => remindersCalendar({ weekdays: 0, minutes: 0, from: "2026-10-26" as LocalDate, now: 0 as EpochMs, uid: "x", title: "Séance" })).toThrow(EmptyReminderError);
  });
});
