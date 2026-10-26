import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { painReport, session, sessionItem, sports, zoneTracking } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate } from "@obnixe/schema";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { revert } from "../undo.ts";
import { commit } from "../writer.ts";
import type { Mutation } from "../writer.ts";
import { emphasisQuantity, fromStored, isFreeSport, quantityUnit, toStored } from "./catalog.ts";
import type { QuantityField } from "./catalog.ts";
import { addDays, daysBetween } from "../stats/dates.ts";
import { parseGrade } from "../stats/indicators.ts";
import { epochAt, localDateOf, localTimeOf, weekdayOf } from "./dates.ts";
import { FutureSessionError, InvalidDurationError, NotFreeSportError, activeSeconds, lastSessionSuggestion, planFreeSession } from "./freeSession.ts";
import type { FreeSessionDraft } from "./freeSession.ts";
import { EmptyGearNameError, gearUsage, newGear } from "./gear.ts";
import { evaluateIndicators } from "./indicators.ts";
import { lastPain, sessionPainMutations, trackedZones, zoneStatuses } from "./pain.ts";

const zone = "Europe/Paris";
let context: TestContext;

beforeEach(() => {
  context = createTestContext();
});

function write(mutations: readonly Mutation[]): Id {
  return commit(context.db, context.env, { actor: { author: "user", connectionId: null }, summary: "Test", revertsId: null, mutations });
}

function draft(overrides: Partial<FreeSessionDraft> = {}): FreeSessionDraft {
  return {
    sport: "run",
    startedAt: (context.env.now() - 3_600_000) as EpochMs,
    durationSeconds: 2496,
    pausedSeconds: 0,
    timeZone: zone,
    values: { kind: "easy", distance: 8000 },
    gearId: null,
    slot: null,
    effort: "moderate",
    sensation: null,
    enjoyment: 4,
    note: "  ",
    pains: [],
    ...overrides,
  };
}

describe("dates", () => {
  it("derives the local day and time in the session time zone", () => {
    const late = Date.UTC(2026, 9, 24, 22, 30);
    expect(localDateOf(late, zone)).toBe("2026-10-25");
    expect(localDateOf(late, "UTC")).toBe("2026-10-24");
    expect(localTimeOf(late, zone)).toEqual({ date: "2026-10-25", minutes: 30 });
  });

  it("converts a wall clock back to an instant across daylight saving changes", () => {
    expect(epochAt({ date: "2026-10-24" as LocalDate, minutes: 14 * 60 + 30 }, zone)).toBe(Date.UTC(2026, 9, 24, 12, 30));
    expect(epochAt({ date: "2026-10-26" as LocalDate, minutes: 14 * 60 + 30 }, zone)).toBe(Date.UTC(2026, 9, 26, 13, 30));
  });

  it("walks calendar days", () => {
    expect(addDays("2026-10-30" as LocalDate, 3)).toBe("2026-11-02");
    expect(addDays("2026-03-01" as LocalDate, -1)).toBe("2026-02-28");
    expect(daysBetween("2026-10-19" as LocalDate, "2026-10-25" as LocalDate)).toBe(6);
    expect(weekdayOf("2026-10-25" as LocalDate)).toBe(0);
  });
});

describe("catalog helpers", () => {
  it("logs only continuous sports as free activities", () => {
    expect(isFreeSport("run")).toBe(true);
    expect(isFreeSport("yoga")).toBe(true);
    expect(isFreeSport("climb")).toBe(false);
    expect(isFreeSport("strength")).toBe(false);
  });

  it("chooses dimension-aware display units", () => {
    const distance = emphasisQuantity(sports.run) as QuantityField;
    const run = quantityUnit("run", distance, "kg");
    expect(run.symbol).toBe("km");
    expect(toStored(8.42, run)).toBe(8420);
    expect(fromStored(8420, run)).toBe(8.42);
    expect(quantityUnit("swim", distance, "kg").symbol).toBe("m");
    const pack = sports.hike.sessionFields.find((field) => field.key === "pack_mass") as QuantityField;
    expect(toStored(7, quantityUnit("hike", pack, "kg"))).toBe(7000);
    expect(fromStored(7000, quantityUnit("hike", pack, "lb"))).toBe(15.4);
    const elevation = sports.run.sessionFields.find((field) => field.key === "elevation_gain") as QuantityField;
    expect(quantityUnit("run", elevation, "kg").symbol).toBe("m");
  });
});

describe("indicators", () => {
  it("computes pace and speed ratios from the catalog", () => {
    const [pace] = evaluateIndicators(sports.run, { durationSeconds: 2496, values: { distance: 8000 }, items: [] });
    expect(pace).toMatchObject({ key: "pace", value: 312 });
    const [speed] = evaluateIndicators(sports.hike, { durationSeconds: 21600, values: { distance: 21400 }, items: [] });
    expect(speed?.value).toBeCloseTo(3566.7, 1);
    expect(evaluateIndicators(sports.run, { durationSeconds: 2496, values: {}, items: [] })).toEqual([]);
  });

  it("parses grades only within known scales", () => {
    expect(parseGrade("fontainebleau:6B")).toEqual({ scale: "fontainebleau", index: 7, label: "6B" });
    expect(parseGrade("french:6B")).toBeNull();
    expect(parseGrade(12)).toBeNull();
  });
});

describe("free sessions", () => {
  it("records one completed session awaiting review", () => {
    const plan = planFreeSession(context.db, context.env, draft());
    write(plan.mutations);
    const stored = context.db.select().from(session).where(eq(session.id, plan.sessionId)).get();
    expect(stored).toMatchObject({ sport: "run", status: "completed", review: "pending", countsInRotation: false, slotId: null, note: null, localDate: "2026-10-24", enjoyment: 4 });
    expect(stored === undefined ? 0 : activeSeconds(stored, context.env.now())).toBe(2496);
  });

  it("keeps pauses out of the active duration", () => {
    const plan = planFreeSession(context.db, context.env, draft({ durationSeconds: 1800, pausedSeconds: 300 }));
    write(plan.mutations);
    const stored = context.db.select().from(session).get();
    expect(stored?.endedAt).toBe((stored?.startedAt ?? 0) + 2_100_000);
    expect(stored === undefined ? 0 : activeSeconds(stored, context.env.now())).toBe(1800);
  });

  it("rejects strength and climbing, bad durations and future starts", () => {
    expect(() => planFreeSession(context.db, context.env, draft({ sport: "climb" }))).toThrow(NotFreeSportError);
    expect(() => planFreeSession(context.db, context.env, draft({ durationSeconds: 0 }))).toThrow(InvalidDurationError);
    expect(() => planFreeSession(context.db, context.env, draft({ pausedSeconds: -1 }))).toThrow(InvalidDurationError);
    expect(() => planFreeSession(context.db, context.env, draft({ startedAt: (context.env.now() + 60_000) as EpochMs }))).toThrow(FutureSessionError);
  });

  it("lets the catalog reject values the sport does not define", () => {
    const plan = planFreeSession(context.db, context.env, draft({ values: { kind: "sprint" } }));
    expect(() => write(plan.mutations)).toThrow(ZodError);
    expect(context.db.select().from(session).all()).toHaveLength(0);
  });

  it("counts in the rotation only when launched for a slot", () => {
    const programId = context.env.newId();
    const versionId = context.env.newId();
    const slotId = context.env.newId();
    write([
      { kind: "insert", table: "program", row: { id: programId, status: "active" } },
      { kind: "insert", table: "program_version", row: { id: versionId, programId, number: 1, name: "Base", sessionsPerWeek: 3, copiedFromId: null, summary: null, reason: null } },
      { kind: "insert", table: "program_slot", row: { id: slotId, versionId, lineageId: slotId, position: 0, sport: "run", name: "Footing", targetDurationSeconds: 2400, targetEffort: "easy", targetValues: {} } },
    ]);
    const plan = planFreeSession(context.db, context.env, draft({ slot: { slotId, variantId: null, countsInRotation: true } }));
    write(plan.mutations);
    expect(context.db.select().from(session).get()).toMatchObject({ slotId, countsInRotation: true });
  });

  it("drops gear for sports that do not use it", () => {
    const shoes = newGear(context.env, "run", "Pegasus 40");
    write([shoes.mutation]);
    const plan = planFreeSession(context.db, context.env, draft({ sport: "yoga", values: { kind: "yin" }, gearId: shoes.gearId }));
    write(plan.mutations);
    expect(context.db.select().from(session).get()?.gearId).toBeNull();
  });

  it("reports pains at the end and opens zone tracking once", () => {
    const plan = planFreeSession(context.db, context.env, draft({ pains: [{ zone: "knee_right", level: "discomfort" }, { zone: "ankle_left", level: "none" }] }));
    write(plan.mutations);
    const reports = context.db.select().from(painReport).all();
    expect(reports.map((report) => [report.zone, report.level, report.phase])).toEqual([["knee_right", "discomfort", "end"], ["ankle_left", "none", "end"]]);
    expect(trackedZones(context.db)).toEqual(["knee_right"]);
    const again = planFreeSession(context.db, context.env, draft({ pains: [{ zone: "knee_right", level: "stop" }] }));
    write(again.mutations);
    expect(context.db.select().from(zoneTracking).all()).toHaveLength(1);
    expect(lastPain(context.db, "knee_right")?.level).toBe("stop");
    expect(zoneStatuses(context.db, ["knee_right", "hip_left"])).toEqual([
      { zone: "knee_right", tracked: true, last: { level: "stop", localDate: "2026-10-24" } },
      { zone: "hip_left", tracked: false, last: null },
    ]);
  });

  it("undoes the whole entry including pains and tracking", () => {
    const plan = planFreeSession(context.db, context.env, draft({ pains: [{ zone: "knee_right", level: "stop" }] }));
    const changesetId = write(plan.mutations);
    revert(context.db, context.env, { actor: { author: "user", connectionId: null }, changesetId, summary: "Annulation", restoredVersionSummary: () => "" });
    expect(context.db.select().from(session).all()).toHaveLength(0);
    expect(context.db.select().from(painReport).all()).toHaveLength(0);
    expect(context.db.select().from(zoneTracking).all()).toHaveLength(0);
  });

  it("suggests the last session of the same sport", () => {
    expect(lastSessionSuggestion(context.db, "run")).toBeNull();
    write(planFreeSession(context.db, context.env, draft()).mutations);
    context.advance(86_400_000);
    write(planFreeSession(context.db, context.env, draft({ sport: "swim", values: { distance: 1500 }, durationSeconds: 1920 })).mutations);
    expect(lastSessionSuggestion(context.db, "run")).toEqual({ emphasis: 8000, durationSeconds: 2496, localDate: "2026-10-24" });
    expect(lastSessionSuggestion(context.db, "swim")?.emphasis).toBe(1500);
  });
});

describe("gear", () => {
  it("adds travelled distance to the initial meters", () => {
    const shoes = newGear(context.env, "run", " Pegasus 40 ");
    write([shoes.mutation]);
    write(planFreeSession(context.db, context.env, draft({ gearId: shoes.gearId })).mutations);
    write(planFreeSession(context.db, context.env, draft({ gearId: shoes.gearId, values: { kind: "long" } })).mutations);
    const [usage] = gearUsage(context.db, "run");
    expect(usage?.gear.name).toBe("Pegasus 40");
    expect(usage?.meters).toBe(8000);
    expect(gearUsage(context.db, "bike")).toEqual([]);
    expect(() => newGear(context.env, "run", "  ")).toThrow(EmptyGearNameError);
  });
});

describe("session pain mutations", () => {
  it("anchors pains to an item and deduplicates zones", () => {
    const climbId = context.env.newId();
    const itemId = context.env.newId();
    write([
      {
        kind: "insert",
        table: "session",
        row: {
          id: climbId,
          sport: "climb",
          slotId: null,
          variantId: null,
          countsInRotation: false,
          gearId: null,
          title: null,
          status: "in_progress",
          startedAt: context.env.now(),
          endedAt: null,
          pausedSeconds: 0,
          localDate: "2026-10-24" as LocalDate,
          timeZone: zone,
          values: { discipline: "boulder" },
          effort: null,
          sensation: null,
          enjoyment: null,
          note: null,
          review: "pending",
          deletedAt: null,
        },
      },
      { kind: "insert", table: "session_item", row: { id: itemId, sessionId: climbId, position: 0, values: { grade: "fontainebleau:6A", attempts: 1, result: "flash" }, recordedAt: context.env.now() } },
    ]);
    const plan = sessionPainMutations(context.db, context.env, { sessionId: climbId, phase: "between", strengthSetId: null, sessionItemId: itemId, occurredAt: context.env.now(), timeZone: zone }, [
      { zone: "fingers_right", level: "discomfort" },
      { zone: "fingers_right", level: "stop" },
    ]);
    write(plan.mutations);
    expect(plan.reportIds).toHaveLength(1);
    expect(context.db.select().from(painReport).get()).toMatchObject({ level: "stop", sessionItemId: itemId, phase: "between" });
    expect(context.db.select().from(sessionItem).all()).toHaveLength(1);
  });
});
