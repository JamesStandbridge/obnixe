import { beforeEach, describe, expect, it } from "vitest";
import type { LocalDate } from "@obnixe/schema";
import { createTestContext } from "../testing.ts";
import { calendarMonth, checkInDays, dayPain, monthFacts, weighInDays } from "./calendar.ts";
import { completedSessions } from "./sessions.ts";
import { Seeder } from "./testing.ts";
import { plannedDays, regularity, weekSummary } from "./week.ts";

const d = (value: string): LocalDate => value as LocalDate;

let seed: Seeder;

beforeEach(() => {
  seed = new Seeder(createTestContext());
});

function seedOctober(): void {
  const squat = seed.exercise("Squat barre");
  const sets = [{ kg: 80, reps: 8, rir: 2 }, { kg: 80, reps: 8, rir: 2 }, { kg: 80, reps: 7, rir: 1 }];
  seed.session({ sport: "climb", date: "2026-10-19", minutes: 80, values: { discipline: "boulder" }, items: [{ grade: "fontainebleau:6B", attempts: 2, result: "sent" }], pains: [{ zone: "fingers_right", level: "discomfort" }] });
  seed.session({ sport: "strength", date: "2026-10-20", minutes: 54, effort: "moderate", entries: [{ exerciseId: squat, sets }], pains: [{ zone: "shoulder_right", level: "discomfort" }] });
  seed.session({ sport: "run", date: "2026-10-22", minutes: 42, values: { kind: "easy", distance: 8000 } });
  seed.session({ sport: "strength", date: "2026-10-24", minutes: 58, effort: "hard", entries: [{ exerciseId: squat, sets }], pains: [{ zone: "shoulder_right", level: "stop" }, { zone: "shoulder_right", level: "discomfort" }] });
  seed.session({ sport: "run", date: "2026-10-12", minutes: 47, values: { kind: "intervals", distance: 9200 } });
  seed.session({ sport: "run", date: "2026-10-23", minutes: 30, values: { kind: "easy", distance: 5000 }, deleted: true });
  seed.session({ sport: "strength", date: "2026-10-25", status: "interrupted", minutes: 20 });
  seed.checkIn("2026-10-21", 2, [{ zone: "shoulder_right", level: "discomfort" }, { zone: "knee_right", level: "none" }]);
  seed.checkIn("2026-10-23", 3, [{ zone: "knee_right", level: "none" }]);
}

describe("completed sessions", () => {
  it("summarizes completed, untrashed sessions with durations and worst pain per zone", () => {
    seedOctober();
    const sessions = completedSessions(seed.context.db, { from: d("2026-10-19"), to: d("2026-10-25") });
    expect(sessions.map((item) => item.localDate)).toEqual(["2026-10-19", "2026-10-20", "2026-10-22", "2026-10-24"]);
    const last = sessions[3];
    expect(last?.durationSeconds).toBe(58 * 60);
    expect(last?.strengthSets).toBe(3);
    expect(last?.pains).toEqual([{ zone: "shoulder_right", level: "stop" }]);
    expect(sessions[0]?.items).toHaveLength(1);
  });

  it("names the agent that added a session", () => {
    const cursor = seed.agent("Cursor");
    seed.session({ sport: "run", date: "2026-10-12", values: { kind: "intervals", distance: 9200 } }, cursor);
    expect(completedSessions(seed.context.db)[0]?.addedBy).toBe("Cursor");
  });
});

describe("week summary", () => {
  it("matches the Today mockup week: four done, Sunday planned for five per week", () => {
    seedOctober();
    const sessions = completedSessions(seed.context.db);
    const week = weekSummary(d("2026-10-25"), sessions, 5);
    expect(week.days.map((day) => day.state)).toEqual(["done", "done", "rest", "done", "rest", "done", "planned"]);
    expect(week.days[6]?.isToday).toBe(true);
    expect(week.sessionsDone).toBe(4);
    expect(week.durationSeconds).toBe((80 + 54 + 42 + 58) * 60);
  });

  it("spreads the remaining planned sessions from today onward", () => {
    expect([...plannedDays(d("2026-10-19"), d("2026-10-21"), [d("2026-10-19")], 4)].sort()).toEqual(["2026-10-21", "2026-10-22", "2026-10-24"]);
    expect([...plannedDays(d("2026-10-26"), d("2026-10-21"), [], 3)].sort()).toEqual(["2026-10-26", "2026-10-28", "2026-10-30"]);
    expect(plannedDays(d("2026-10-19"), d("2026-10-21"), [], null).size).toBe(0);
    expect(weekSummary(d("2026-10-25"), [], null).days.every((day) => day.state === "rest")).toBe(true);
  });

  it("averages sessions over the last weeks with planned slots in the current one", () => {
    seedOctober();
    const result = regularity(d("2026-10-25"), completedSessions(seed.context.db), 2, 5);
    expect(result.weeks).toEqual([
      { monday: "2026-10-12", done: 1, planned: 0, isCurrent: false },
      { monday: "2026-10-19", done: 4, planned: 1, isCurrent: true },
    ]);
    expect(result.averagePerWeek).toBe(2.5);
  });
});

describe("calendar month", () => {
  it("lays out October 2026 from Monday with sessions, check-ins, pain and planned days", () => {
    seedOctober();
    const range = { from: d("2026-10-01"), to: d("2026-10-31") };
    const month = calendarMonth({
      month: { year: 2026, month: 10 },
      today: d("2026-10-25"),
      sessions: completedSessions(seed.context.db, range),
      checkIns: checkInDays(seed.context.db, range),
      sessionsPerWeek: 4,
    });
    expect(month.isCurrent).toBe(true);
    expect(month.cells.slice(0, 4).map((cell) => [cell.date, cell.inMonth])).toEqual([
      ["2026-09-28", false],
      ["2026-09-29", false],
      ["2026-09-30", false],
      ["2026-10-01", true],
    ]);
    expect(month.cells).toHaveLength(34);
    const byDate = new Map(month.cells.map((cell) => [cell.date, cell]));
    expect(byDate.get(d("2026-10-21"))?.checkIn?.energy).toBe(2);
    expect(dayPain(byDate.get(d("2026-10-21")) ?? { sessions: [], checkIn: null }, null)).toBe("discomfort");
    expect(dayPain(byDate.get(d("2026-10-24")) ?? { sessions: [], checkIn: null }, "run")).toBeNull();
    expect(dayPain(byDate.get(d("2026-10-23")) ?? { sessions: [], checkIn: null }, null)).toBeNull();
    expect(month.cells.filter((cell) => cell.planned).map((cell) => cell.date)).toEqual(["2026-10-26", "2026-10-27", "2026-10-29", "2026-10-31"]);
    expect(monthFacts(month, null)).toEqual({ sessions: 5, durationSeconds: (80 + 54 + 42 + 58 + 47) * 60, painDays: 4 });
    expect(monthFacts(month, "run")).toEqual({ sessions: 2, durationSeconds: (42 + 47) * 60, painDays: 1 });
  });

  it("reads weigh-ins and skips trashed check-ins", () => {
    seed.write([{ kind: "insert", table: "weigh_in", row: { id: seed.id(), occurredAt: seed.context.env.now(), localDate: d("2026-10-20"), timeZone: "Europe/Paris", grams: 75_100, deletedAt: null } }]);
    expect(weighInDays(seed.context.db, { from: d("2026-10-01"), to: d("2026-10-31") })).toEqual([{ localDate: "2026-10-20", grams: 75_100 }]);
    expect(checkInDays(seed.context.db, { from: d("2026-10-01"), to: d("2026-10-31") })).toEqual([]);
  });
});
