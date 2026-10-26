import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { agentCall, changeset, checkIn, measurement, measurementKind, painReport, settings, weighIn, zoneTracking } from "@obnixe/schema";
import type { Id } from "@obnixe/schema";
import { at, Seeder } from "../stats/testing.ts";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import type { Actor } from "../writer.ts";
import { openConnection } from "./connection.ts";
import { runAgentTool } from "./dispatch.ts";
import { toggleChange } from "./history.ts";
import type { ToolOutcome } from "./protocol.ts";

const user: Actor = { author: "user", connectionId: null };
const timeZone = "Europe/Paris";

let context: TestContext;
let seed: Seeder;
let connectionId: Id;

interface Permissions {
  readonly agentCanReadBody: boolean;
  readonly agentCanWrite: boolean;
}

function allow(permissions: Partial<Permissions>): void {
  context.db.update(settings).set(permissions).run();
}

beforeEach(() => {
  context = createTestContext();
  seed = new Seeder(context);
  context.db
    .insert(settings)
    .values({
      singleton: 1,
      theme: "dark",
      massUnit: "kg",
      agentCanReadBody: false,
      agentCanWrite: false,
      agentCanReadPhotos: false,
      reminderWeekdays: 0,
      reminderMinutes: 1110,
      remindersExportedAt: null,
      agentChangesSeenAt: null,
      bridgeHost: null,
      updatedAt: context.env.now(),
    })
    .run();
  connectionId = openConnection(context.db, context.env, { client: "Cursor", host: "MacBook Pro" });
});

function call(tool: string, args: unknown): ToolOutcome {
  context.advance(1000);
  return runAgentTool(context.db, context.env, { connectionId, tool, arguments: args, timeZone });
}

function ok<T>(tool: string, args: unknown): T {
  const outcome = call(tool, args);
  if (outcome.isError) throw new Error(`${tool} failed: ${outcome.text}`);
  return JSON.parse(outcome.text) as T;
}

function lastCall(): { tool: string; summary: string; changesetId: Id | null } | undefined {
  return context.db.select({ tool: agentCall.tool, summary: agentCall.summary, changesetId: agentCall.changesetId }).from(agentCall).orderBy(asc(agentCall.calledAt)).all().at(-1);
}

function undoLast(): void {
  const write = lastCall();
  if (write?.changesetId == null) throw new Error("No write to undo");
  toggleChange(context.db, context.env, user, write.changesetId, write.summary);
}

interface SuggestedSet {
  readonly loadGrams: number | null;
  readonly reps: number | null;
}

interface NextExercise {
  readonly name: string;
  readonly zones: readonly string[];
  readonly pain: { readonly zone: string; readonly level: string; readonly localDate: string } | null;
  readonly lastPerformance: { readonly localDate: string; readonly sets: readonly { readonly loadGrams: number | null; readonly reps: number | null }[] } | null;
  readonly suggestion: { readonly kind: string; readonly sets: readonly SuggestedSet[] };
}

interface NextSession {
  readonly today: string;
  readonly program: { readonly name: string; readonly sessionsPerWeek: number } | null;
  readonly week: { readonly sessionsDone: number; readonly sessionsPlanned: number | null; readonly today: string } | null;
  readonly openSession: { readonly sessionId: string } | null;
  readonly checkIn: { readonly energy: number | null } | null;
  readonly next: {
    readonly name: string;
    readonly sport: string;
    readonly lastCompletedOn: string | null;
    readonly daysSinceLastCompleted: number | null;
    readonly variants: readonly { readonly name: string; readonly isDefault: boolean; readonly estimatedDurationSeconds: number | null; readonly exercises: readonly NextExercise[] }[];
  } | null;
  readonly after: { readonly name: string } | null;
  readonly painOnLoadedZones: readonly { readonly zone: string; readonly level: string; readonly followed: boolean }[];
}

describe("get_next_session", () => {
  function seedProgram(): { squat: Id; slotA: Id; slotB: Id } {
    const squat = seed.exercise("Squat", "load_reps", ["knee_right"]);
    const plank = seed.exercise("Gainage", "duration", ["lower_back"]);
    const program = seed.program("Base hiver", 3, [
      {
        sport: "strength",
        name: "Séance A",
        variants: [
          { name: "Salle", items: [{ exerciseId: squat, sets: 3, reps: [6, 8], restSeconds: 150 }] },
          { name: "Maison", items: [{ exerciseId: plank, sets: 3, duration: [30, 45] }] },
        ],
      },
      { sport: "run", name: "Footing", targetDurationSeconds: 2100 },
    ]);
    const slotA = program.slotIds[0];
    const slotB = program.slotIds[1];
    if (slotA === undefined || slotB === undefined) throw new Error("Missing slots");
    return { squat, slotA, slotB };
  }

  it("answers without an active program", () => {
    const data = ok<NextSession>("get_next_session", {});
    expect(data).toMatchObject({ today: "2026-10-24", program: null, next: null, openSession: null });
    expect(lastCall()?.summary).toBe("Prochaine séance");
  });

  it("returns the rotation's next slot with last performance, progression and days since last done", () => {
    const { squat, slotA, slotB } = seedProgram();
    seed.session({ sport: "strength", date: "2026-10-17", slotId: slotA, entries: [{ exerciseId: squat, sets: [{ kg: 80, reps: 8, rir: 2 }, { kg: 80, reps: 8, rir: 1 }, { kg: 80, reps: 8, rir: 1 }] }] });
    seed.session({ sport: "run", date: "2026-10-20", slotId: slotB, values: { distance: 6000 } });

    const data = ok<NextSession>("get_next_session", {});
    expect(lastCall()?.summary).toBe("Prochaine séance · Séance A");
    expect(data.program).toMatchObject({ name: "Base hiver", sessionsPerWeek: 3 });
    expect(data.week).toMatchObject({ sessionsDone: 1, sessionsPlanned: 3 });
    expect(data.after?.name).toBe("Footing");
    expect(data.next).toMatchObject({ name: "Séance A", sport: "strength", lastCompletedOn: "2026-10-17", daysSinceLastCompleted: 7 });
    expect(data.next?.variants.map((variant) => [variant.name, variant.isDefault])).toEqual([
      ["Salle", true],
      ["Maison", false],
    ]);
    const squatPlan = data.next?.variants[0]?.exercises[0];
    expect(squatPlan).toMatchObject({ name: "Squat", zones: ["knee_right"], pain: null, lastPerformance: { localDate: "2026-10-17" } });
    expect(squatPlan?.lastPerformance?.sets).toHaveLength(3);
    expect(squatPlan?.suggestion.kind).toBe("increase_load");
    expect(squatPlan?.suggestion.sets[0]).toMatchObject({ loadGrams: 82_500, reps: 6 });
    expect(data.next?.variants[1]?.exercises[0]).toMatchObject({ name: "Gainage", lastPerformance: null, suggestion: { kind: "first" } });
    expect(data.painOnLoadedZones).toEqual([]);
  });

  it("moves to the following slot once the next one is done", () => {
    const { squat, slotA } = seedProgram();
    seed.session({ sport: "strength", date: "2026-10-23", slotId: slotA, entries: [{ exerciseId: squat, sets: [{ kg: 80, reps: 8 }] }] });
    const data = ok<NextSession>("get_next_session", {});
    expect(data.next).toMatchObject({ name: "Footing", sport: "run", lastCompletedOn: null, daysSinceLastCompleted: null, variants: [] });
    expect(data.after?.name).toBe("Séance A");
  });

  it("suspends progression on a painful loaded zone and lists the zone", () => {
    const squat = seed.exercise("Squat", "load_reps", ["knee_right"]);
    const program = seed.program("Base", 2, [{ sport: "strength", name: "Séance A", variants: [{ name: "Salle", items: [{ exerciseId: squat, sets: 3, reps: [6, 8] }] }] }]);
    seed.session({ sport: "strength", date: "2026-10-17", slotId: program.slotIds[0] ?? ("" as Id), entries: [{ exerciseId: squat, sets: [{ kg: 80, reps: 8, rir: 2 }, { kg: 80, reps: 8, rir: 2 }, { kg: 80, reps: 8, rir: 2 }] }] });
    seed.checkIn("2026-10-23", 3, [{ zone: "knee_right", level: "stop" }]);

    const data = ok<NextSession>("get_next_session", {});
    const exercise = data.next?.variants[0]?.exercises[0];
    expect(exercise?.pain).toEqual({ zone: "knee_right", zoneLabel: "Genou droit", level: "stop", localDate: "2026-10-23" });
    expect(exercise?.suggestion.kind).toBe("suspended");
    expect(exercise?.suggestion.sets[0]).toMatchObject({ loadGrams: 80_000, reps: 8 });
    expect(data.painOnLoadedZones).toEqual([{ zone: "knee_right", zoneLabel: "Genou droit", level: "stop", localDate: "2026-10-23", followed: false }]);
    expect(data.checkIn).toBeNull();
  });

  it("shows an unfinished session", () => {
    seed.program("Base", 2, [{ sport: "run", name: "Footing" }]);
    const open = seed.session({ sport: "run", date: "2026-10-24", startedAt: at("2026-10-24", "12:00"), status: "in_progress" });
    expect(ok<NextSession>("get_next_session", {}).openSession?.sessionId).toBe(open);
  });
});

describe("body permissions", () => {
  it("requires write and body for weigh-ins and measurements, write only for check-ins and pain", () => {
    const weigh = { grams: 78_400 };
    allow({ agentCanWrite: true });
    expect(call("log_weigh_in", weigh).text).toContain("Lire le corps");
    expect(call("log_measurements", { measurements: [{ kind: "Tour de taille", millimeters: 820 }], createMissingKinds: true }).text).toContain("Lire le corps");
    allow({ agentCanWrite: false, agentCanReadBody: true });
    expect(call("log_weigh_in", weigh).text).toContain("Modifier directement");
    expect(call("log_check_in", { energy: 4 }).text).toContain("Modifier directement");
    expect(call("report_pain", { zone: "knee_right", level: "discomfort" }).text).toContain("Modifier directement");
    expect(context.db.select().from(weighIn).all()).toHaveLength(0);
    expect(context.db.select().from(agentCall).all()).toHaveLength(0);

    allow({ agentCanWrite: true, agentCanReadBody: false });
    expect(call("log_check_in", { energy: 4 }).isError).toBe(false);
    expect(call("report_pain", { zone: "knee_right", level: "discomfort" }).isError).toBe(false);
    allow({ agentCanReadBody: true });
    expect(call("log_weigh_in", weigh).isError).toBe(false);
  });
});

describe("check-in", () => {
  beforeEach(() => allow({ agentCanWrite: true }));

  it("keeps one check-in per day, updating answered fields", () => {
    const first = ok<{ checkInId: Id }>("log_check_in", { energy: 4 });
    expect(lastCall()?.summary).toBe("Check-in du 24 octobre · énergie 4/5");
    const second = ok<{ checkInId: Id; energy: number; sleep: string }>("log_check_in", { sleep: "h7" });
    expect(second).toMatchObject({ checkInId: first.checkInId, energy: 4, sleep: "h7" });
    expect(lastCall()?.summary).toBe("Check-in du 24 octobre · énergie 4/5, sommeil 7 h");
    expect(context.db.select().from(checkIn).all()).toEqual([expect.objectContaining({ localDate: "2026-10-24", energy: 4, sleep: "h7" })]);
    expect(call("log_check_in", { sleep: "h7" }).text).toContain("nothing changed");
  });

  it("validates input and dates", () => {
    expect(call("log_check_in", {}).text).toContain("Give 'energy', 'sleep' or both");
    expect(call("log_check_in", { energy: 6 }).text).toContain("Invalid input");
    expect(call("log_check_in", { energy: 3, localDate: "2026-10-25" }).text).toContain("future");
    ok("log_check_in", { energy: 2, localDate: "2026-10-22" });
    expect(context.db.select().from(checkIn).all()).toEqual([expect.objectContaining({ localDate: "2026-10-22", energy: 2 })]);
  });

  it("is undone from the phone", () => {
    ok("log_check_in", { energy: 4 });
    ok("log_check_in", { energy: 2 });
    undoLast();
    expect(context.db.select().from(checkIn).get()?.energy).toBe(4);
  });
});

describe("report_pain", () => {
  beforeEach(() => allow({ agentCanWrite: true }));

  it("records pain without a session in the day's check-in, one level per zone", () => {
    const first = ok<{ painReportId: Id; checkInId: Id }>("report_pain", { zone: "knee_right", level: "discomfort" });
    expect(lastCall()?.summary).toBe("Douleur · Genou droit : gêne · check-in du 24 octobre");
    const second = ok<{ painReportId: Id; checkInId: Id }>("report_pain", { zone: "knee_right", level: "stop" });
    expect(second).toEqual(expect.objectContaining({ painReportId: first.painReportId, checkInId: first.checkInId }));
    expect(context.db.select().from(painReport).all()).toEqual([expect.objectContaining({ zone: "knee_right", level: "stop", checkInId: first.checkInId, sessionId: null, phase: null })]);
    expect(context.db.select().from(zoneTracking).all()).toHaveLength(0);
    expect(call("report_pain", { zone: "knee_right", level: "stop" }).text).toContain("nothing changed");
  });

  it("attaches pain to a session and opens zone follow-up once", () => {
    const sessionId = seed.session({ sport: "run", date: "2026-10-20", startedAt: at("2026-10-20", "16:00"), minutes: 50 });
    const result = ok<{ zoneFollowUpOpened: boolean; localDate: string }>("report_pain", { zone: "ankle_left", level: "discomfort", sessionId, phase: "end" });
    expect(result).toMatchObject({ zoneFollowUpOpened: true, localDate: "2026-10-20" });
    expect(lastCall()?.summary).toBe("Douleur · Cheville gauche : gêne · Course du 20 octobre");
    expect(context.db.select().from(painReport).get()).toMatchObject({ sessionId, phase: "end", occurredAt: at("2026-10-20", "16:50"), localDate: "2026-10-20", checkInId: null });
    expect(ok<{ zoneFollowUpOpened: boolean }>("report_pain", { zone: "ankle_left", level: "stop", sessionId, phase: "during" }).zoneFollowUpOpened).toBe(false);
    expect(context.db.select().from(zoneTracking).all()).toEqual([expect.objectContaining({ zone: "ankle_left", reason: "pain_reported", endedAt: null })]);

    undoLast();
    expect(context.db.select().from(painReport).all()).toHaveLength(1);
  });

  it("validates the session link", () => {
    const sessionId = seed.session({ sport: "run", date: "2026-10-20" });
    expect(call("report_pain", { zone: "ankle_left", level: "stop", sessionId }).text).toContain("'phase' is required");
    expect(call("report_pain", { zone: "ankle_left", level: "stop", phase: "end" }).text).toContain("only allowed with 'sessionId'");
    expect(call("report_pain", { zone: "ankle_left", level: "stop", sessionId, phase: "end", localDate: "2026-10-20" }).text).toContain("Omit 'localDate'");
    expect(call("report_pain", { zone: "ankle_left", level: "stop", sessionId: "missing", phase: "end" }).text).toContain("No session");
    expect(call("report_pain", { zone: "elbow", level: "stop" }).text).toContain("Invalid input");
    expect(context.db.select().from(painReport).all()).toHaveLength(0);
  });

  it("undoes the report and the follow-up it opened together", () => {
    const sessionId = seed.session({ sport: "run", date: "2026-10-20" });
    ok("report_pain", { zone: "knee_left", level: "stop", sessionId, phase: "before" });
    undoLast();
    expect(context.db.select().from(painReport).all()).toHaveLength(0);
    expect(context.db.select().from(zoneTracking).all()).toHaveLength(0);
  });
});

describe("weigh-ins", () => {
  beforeEach(() => allow({ agentCanWrite: true, agentCanReadBody: true }));

  it("keeps one weigh-in per day and can be undone", () => {
    ok("log_weigh_in", { grams: 78_400 });
    expect(lastCall()?.summary).toBe("Pesée du 24 octobre · 78,4 kg");
    const replaced = ok<{ replacedGrams: number | null }>("log_weigh_in", { grams: 78_000 });
    expect(replaced.replacedGrams).toBe(78_400);
    expect(context.db.select().from(weighIn).all()).toEqual([expect.objectContaining({ localDate: "2026-10-24", grams: 78_000 })]);
    expect(call("log_weigh_in", { grams: 78_000 }).text).toContain("nothing changed");
    undoLast();
    expect(context.db.select().from(weighIn).get()?.grams).toBe(78_400);
  });

  it("validates bounds and dates, stamping past days in the morning", () => {
    expect(call("log_weigh_in", { grams: 1000 }).text).toContain("Invalid input");
    expect(call("log_weigh_in", { grams: 78_000, localDate: "2026-10-30" }).text).toContain("future");
    expect(call("log_weigh_in", { grams: 78_000, localDate: "2025-01-01" }).text).toContain("more than 366 days");
    ok("log_weigh_in", { grams: 77_900, localDate: "2026-10-20" });
    expect(context.db.select().from(weighIn).get()).toMatchObject({ localDate: "2026-10-20", occurredAt: at("2026-10-20", "06:00") });
  });
});

describe("measurements", () => {
  beforeEach(() => allow({ agentCanWrite: true, agentCanReadBody: true }));

  it("refuses unknown kinds unless asked to create them", () => {
    const refused = call("log_measurements", { measurements: [{ kind: "Tour de taille", millimeters: 820 }] });
    expect(refused.text).toContain("No measurement kind matches 'Tour de taille'");
    expect(refused.text).toContain("createMissingKinds");
    const created = ok<{ createdKinds: { label: string }[] }>("log_measurements", {
      measurements: [
        { kind: "Tour de taille", millimeters: 820 },
        { kind: "Tour de bras", millimeters: 345 },
      ],
      createMissingKinds: true,
    });
    expect(created.createdKinds.map((kind) => kind.label)).toEqual(["Tour de taille", "Tour de bras"]);
    expect(lastCall()?.summary).toBe("Mensurations du 24 octobre · 2 mesures");
    expect(context.db.select().from(measurementKind).orderBy(asc(measurementKind.position)).all().map((kind) => [kind.label, kind.position])).toEqual([
      ["Tour de taille", 0],
      ["Tour de bras", 1],
    ]);
  });

  it("matches kinds by label, replaces the day's value and can be undone", () => {
    ok("log_measurements", { measurements: [{ kind: "Tour de taille", millimeters: 820 }], createMissingKinds: true });
    const replaced = ok<{ measurements: { status: string }[] }>("log_measurements", { measurements: [{ kind: "tour de TAILLE", millimeters: 815 }] });
    expect(replaced.measurements[0]?.status).toBe("replaced");
    expect(lastCall()?.summary).toBe("Mensuration du 24 octobre · Tour de taille 81,5 cm");
    expect(context.db.select().from(measurement).all()).toEqual([expect.objectContaining({ millimeters: 815 })]);
    expect(call("log_measurements", { measurements: [{ kind: "Tour de taille", millimeters: 815 }] }).text).toContain("nothing changed");
    expect(call("log_measurements", { measurements: [{ kind: "Tour de taille", millimeters: 800 }, { kind: "TOUR DE TAILLE", millimeters: 810 }] }).text).toContain("given twice");
    undoLast();
    expect(context.db.select().from(measurement).get()?.millimeters).toBe(820);
  });
});

interface AgentChanges {
  readonly changes: readonly {
    readonly changesetId: Id;
    readonly summary: string;
    readonly tool: string | null;
    readonly connection: { readonly client: string | null; readonly current: boolean };
    readonly undoneByUser: boolean;
    readonly rows: readonly { readonly table: string; readonly id: string; readonly operation: string }[];
  }[];
}

describe("list_agent_changes", () => {
  beforeEach(() => allow({ agentCanWrite: true, agentCanReadBody: true }));

  it("lists the agents' writes newest first with touched rows, connection and undo state", () => {
    const codex = seed.agent("Codex");
    seed.session({ sport: "run", date: "2026-10-01" }, codex);
    seed.session({ sport: "run", date: "2026-10-02" });
    const weigh = ok<{ weighInId: Id }>("log_weigh_in", { grams: 78_400 });
    ok("log_check_in", { energy: 4 });
    undoLast();

    const listed = ok<AgentChanges>("list_agent_changes", {});
    expect(listed.changes.map((change) => [change.summary, change.tool, change.connection.client, change.connection.current, change.undoneByUser])).toEqual([
      ["Check-in du 24 octobre · énergie 4/5", "log_check_in", "Cursor", true, true],
      ["Pesée du 24 octobre · 78,4 kg", "log_weigh_in", "Cursor", true, false],
      ["Seed", null, "Codex", false, false],
    ]);
    expect(listed.changes[1]?.rows).toEqual([{ table: "weigh_in", id: weigh.weighInId, operation: "insert" }]);
    expect(lastCall()?.summary).toBe("Modifications des agents");
    expect(ok<AgentChanges>("list_agent_changes", { limit: 1 }).changes).toHaveLength(1);
  });

  it("filters by the local day of the change and validates the range", () => {
    ok("log_check_in", { energy: 4 });
    expect(ok<AgentChanges>("list_agent_changes", { from: "2026-10-24", to: "2026-10-24" }).changes).toHaveLength(1);
    expect(ok<AgentChanges>("list_agent_changes", { from: "2026-10-01", to: "2026-10-23" }).changes).toHaveLength(0);
    expect(call("list_agent_changes", { from: "2026-10-01" }).text).toContain("Give both 'from' and 'to'");
    expect(call("list_agent_changes", { from: "2026-10-24", to: "2026-10-01" }).text).toContain("must not be after");
    expect(context.db.select().from(changeset).where(eq(changeset.author, "agent")).all()).toHaveLength(1);
  });
});
