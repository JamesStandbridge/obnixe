import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { session } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate } from "@obnixe/schema";
import { createTestContext } from "../testing.ts";
import { revert } from "../undo.ts";
import { checkInAnswerMutations, checkInZoneMutations, todayCheckIn } from "./checkin.ts";
import type { CheckInContext } from "./checkin.ts";
import { clampReminderMinutes, reminderDays, reminderMask, remindersIcs, toggleReminderDay } from "./reminders.ts";
import { at, Seeder, userActor } from "./testing.ts";
import { agentChangesSince, estimatedSlotSeconds, finishOpenSessionMutations, openSession, resumeDeadlineDate, todayNotices, trackedZones, variantPlan } from "./today.ts";

const d = (value: string): LocalDate => value as LocalDate;

let seed: Seeder;

beforeEach(() => {
  seed = new Seeder(createTestContext());
});

describe("open session", () => {
  it("finds the interrupted session, counts its sets and completes it with a pending review", () => {
    const squat = seed.exercise("Squat barre");
    const id = seed.session({ sport: "strength", date: "2026-10-25", status: "interrupted", minutes: 30, entries: [{ exerciseId: squat, sets: [{ kg: 80, reps: 8 }, { kg: 80, reps: 8 }, { kg: 80, reps: 7 }] }] });
    const open = openSession(seed.context.db);
    expect(open?.session.id).toBe(id);
    expect(open?.setCount).toBe(3);
    expect(open?.lastActivityAt).toBe(at("2026-10-25", "10:30"));
    if (open === null) throw new Error("No open session");
    seed.write(finishOpenSessionMutations(open));
    const row = seed.context.db.select().from(session).where(eq(session.id, id)).get();
    expect(row?.status).toBe("completed");
    expect(row?.review).toBe("pending");
    expect(row?.endedAt).toBe(at("2026-10-25", "10:30"));
    expect(openSession(seed.context.db)).toBeNull();
  });

  it("ends an in-progress session at its last recorded set", () => {
    const squat = seed.exercise("Squat barre");
    seed.session({ sport: "strength", date: "2026-10-25", status: "in_progress", entries: [{ exerciseId: squat, sets: [{ kg: 80, reps: 8 }, { kg: 80, reps: 8 }] }] });
    const open = openSession(seed.context.db);
    if (open === null) throw new Error("No open session");
    expect(open.lastActivityAt).toBe(at("2026-10-25", "10:02"));
    const [mutation] = finishOpenSessionMutations(open);
    expect(mutation).toMatchObject({ kind: "update", patch: { status: "completed", endedAt: at("2026-10-25", "10:02") } });
  });

  it("keeps the resume window until 6 am", () => {
    expect(resumeDeadlineDate({ date: d("2026-10-25"), minutes: 14 * 60 + 44 })).toBe("2026-10-26");
    expect(resumeDeadlineDate({ date: d("2026-10-25"), minutes: 2 * 60 })).toBe("2026-10-25");
  });
});

describe("notices", () => {
  it("carries recent pain until a calmer report, lists agent changes since last seen and pending reviews", () => {
    seed.session({ sport: "strength", date: "2026-10-24", pains: [{ zone: "shoulder_right", level: "stop" }], review: "pending", title: "Séance A" });
    seed.session({ sport: "run", date: "2026-10-22", values: { kind: "easy", distance: 8000 }, pains: [{ zone: "knee_right", level: "discomfort" }] });
    seed.session({ sport: "run", date: "2026-10-18", values: { kind: "easy" }, pains: [{ zone: "ankle_left", level: "stop" }] });
    seed.checkIn("2026-10-23", 3, [{ zone: "knee_right", level: "none" }]);
    const cursor = seed.agent("Cursor");
    const first = seed.session({ sport: "run", date: "2026-10-12", values: { kind: "intervals", distance: 9200 } }, cursor);
    seed.context.advance(60_000);
    const seenAt = seed.context.env.now();
    seed.context.advance(60_000);
    seed.write([{ kind: "update", table: "session", key: first, patch: { note: "6 × 800 m" } }], cursor);
    seed.context.advance(60_000);
    const undone = seed.write([{ kind: "update", table: "session", key: first, patch: { note: "6 × 1000 m" } }], cursor);
    revert(seed.context.db, seed.context.env, { actor: userActor, changesetId: undone, summary: "Annulation", restoredVersionSummary: () => "" });

    const notices = todayNotices(seed.context.db, { today: d("2026-10-25"), agentChangesSeenAt: null });
    expect(notices.pains).toEqual([{ zone: "shoulder_right", level: "stop", localDate: "2026-10-24" }]);
    expect(notices.agent).toMatchObject({ count: 2, client: "Cursor" });
    expect(agentChangesSince(seed.context.db, seenAt)?.count).toBe(1);
    expect(agentChangesSince(seed.context.db, seed.context.env.now())).toBeNull();
    expect(notices.reviews.map((review) => [review.localDate, review.title])).toEqual([["2026-10-24", "Séance A"]]);
  });

  it("plans a variant with last loads, zones and an estimated duration", () => {
    const rdl = seed.exercise("Soulevé de terre roumain");
    const press = seed.exercise("Développé militaire", "load_reps", ["shoulder_right"]);
    const plank = seed.exercise("Gainage latéral", "duration");
    const program = seed.program("Base hiver", 5, [
      {
        sport: "strength",
        name: "Séance B",
        variants: [
          { name: "Salle", items: [{ exerciseId: rdl, sets: 3, reps: [6, 8] }, { exerciseId: press, sets: 3, reps: [6, 10] }, { exerciseId: plank, sets: 3, duration: [30, 45], restSeconds: 60 }] },
          { name: "Sans matériel", items: [{ exerciseId: plank, sets: 3, duration: [30, 45] }] },
        ],
      },
      { sport: "run", name: "Footing", targetDurationSeconds: 2400 },
    ]);
    seed.session({ sport: "strength", date: "2026-10-20", entries: [{ exerciseId: press, sets: [{ kg: 42.5, reps: 8, rir: 2 }, { kg: 45, reps: 6, rir: 1 }] }] });
    const variantId = program.variantIds[0]?.[0] as Id;
    const plan = variantPlan(seed.context.db, variantId);
    expect(plan.map((item) => item.name)).toEqual(["Soulevé de terre roumain", "Développé militaire", "Gainage latéral"]);
    expect(plan[1]?.zones).toEqual(["shoulder_right"]);
    expect(plan[1]?.last?.top.loadGrams).toBe(45_000);
    expect(plan[0]?.last).toBeNull();
    expect(estimatedSlotSeconds({ targetDurationSeconds: null }, plan)).toBe(1500);
    expect(estimatedSlotSeconds({ targetDurationSeconds: 2400 }, [])).toBe(2400);
    expect(estimatedSlotSeconds({ targetDurationSeconds: null }, [])).toBeNull();
  });

  it("tracks open zones and recently painful ones with today's check-in level", () => {
    seed.write([{ kind: "insert", table: "zone_tracking", row: { id: seed.id(), zone: "knee_right", reason: "user", painReportId: null, startedAt: at("2026-09-01"), endedAt: null } }]);
    seed.session({ sport: "strength", date: "2026-10-24", pains: [{ zone: "shoulder_right", level: "stop" }] });
    seed.session({ sport: "strength", date: "2026-10-10", pains: [{ zone: "elbow_left", level: "stop" }] });
    const checkInId = seed.checkIn("2026-10-25", 4, [{ zone: "shoulder_right", level: "discomfort" }]);
    const zones = trackedZones(seed.context.db, { today: d("2026-10-25"), checkInId });
    expect(zones.map((zone) => [zone.zone, zone.latest?.level ?? null, zone.latest?.localDate ?? null, zone.todayLevel])).toEqual([
      ["knee_right", null, null, null],
      ["shoulder_right", "stop", "2026-10-24", "discomfort"],
    ]);
  });
});

describe("check-in", () => {
  function context(): CheckInContext {
    return { now: seed.context.env.now(), today: d("2026-10-25"), timeZone: "Europe/Paris", newId: () => seed.id() };
  }

  it("creates one check-in per day and updates it afterwards", () => {
    const first = checkInAnswerMutations(null, { energy: 4 }, context());
    seed.write(first.mutations);
    const stored = todayCheckIn(seed.context.db, d("2026-10-25")).checkIn;
    expect(stored).toMatchObject({ id: first.checkInId, energy: 4, sleep: null });
    if (stored === null) throw new Error("No check-in");
    expect(checkInAnswerMutations(stored, { energy: 4 }, context()).mutations).toEqual([]);
    seed.write(checkInAnswerMutations(stored, { sleep: "h7" }, context()).mutations);
    seed.write(checkInAnswerMutations(todayCheckIn(seed.context.db, d("2026-10-25")).checkIn, { energy: null }, context()).mutations);
    expect(todayCheckIn(seed.context.db, d("2026-10-25")).checkIn).toMatchObject({ id: first.checkInId, energy: null, sleep: "h7" });
  });

  it("writes zone levels as check-in pain reports, clears them softly and reports again", () => {
    const created = checkInZoneMutations(null, null, "shoulder_right", "stop", context());
    expect(created.mutations).toHaveLength(2);
    seed.write(created.mutations);
    let today = todayCheckIn(seed.context.db, d("2026-10-25"));
    expect(today.reports.map((report) => [report.zone, report.level, report.phase, report.checkInId])).toEqual([["shoulder_right", "stop", null, created.checkInId]]);
    const report = today.reports[0] ?? null;
    seed.write(checkInZoneMutations(today.checkIn, report, "shoulder_right", "discomfort", context()).mutations);
    today = todayCheckIn(seed.context.db, d("2026-10-25"));
    expect(today.reports[0]?.level).toBe("discomfort");
    seed.write(checkInZoneMutations(today.checkIn, today.reports[0] ?? null, "shoulder_right", null, context()).mutations);
    today = todayCheckIn(seed.context.db, d("2026-10-25"));
    expect(today.reports).toEqual([]);
    seed.write(checkInZoneMutations(today.checkIn, null, "shoulder_right", "none", context()).mutations);
    expect(todayCheckIn(seed.context.db, d("2026-10-25")).reports.map((item) => item.level)).toEqual(["none"]);
    expect(() => checkInZoneMutations(null, null, "knee_right", null, context())).toThrow();
  });

  it("undoes a check-in answer through the journal", () => {
    const first = checkInAnswerMutations(null, { energy: 2 }, context());
    seed.write(first.mutations);
    const stored = todayCheckIn(seed.context.db, d("2026-10-25")).checkIn;
    const changed = seed.write(checkInAnswerMutations(stored, { energy: 5 }, context()).mutations);
    revert(seed.context.db, seed.context.env, { actor: userActor, changesetId: changed, summary: "Annulation", restoredVersionSummary: () => "" });
    expect(todayCheckIn(seed.context.db, d("2026-10-25")).checkIn?.energy).toBe(2);
  });
});

describe("reminders", () => {
  it("round-trips weekday masks and clamps the time", () => {
    const mask = reminderMask([0, 2, 4]);
    expect(mask).toBe(0b10101);
    expect(reminderDays(mask)).toEqual([0, 2, 4]);
    expect(reminderDays(toggleReminderDay(mask, 2))).toEqual([0, 4]);
    expect(clampReminderMinutes(23 * 60)).toBe(22 * 60);
    expect(clampReminderMinutes(4 * 60)).toBe(5 * 60);
    expect(() => reminderMask([7])).toThrow(RangeError);
  });

  it("exports weekly floating-time events starting on the next matching day", () => {
    const ics = remindersIcs({ mask: reminderMask([0, 3]), minutes: 18 * 60 + 30, from: d("2026-10-25"), stamp: Date.UTC(2026, 9, 25, 9, 0) as EpochMs, summary: "Séance Obnixe", description: "Ouvre Obnixe, la séance du jour t'attend.", durationMinutes: 30 });
    const lines = ics.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines.filter((line) => line === "BEGIN:VEVENT")).toHaveLength(2);
    expect(lines).toContain("DTSTART:20261026T183000");
    expect(lines).toContain("DTEND:20261026T190000");
    expect(lines).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
    expect(lines).toContain("DTSTART:20261029T183000");
    expect(lines).toContain("RRULE:FREQ=WEEKLY;BYDAY=TH");
    expect(lines).toContain("DTSTAMP:20261025T090000Z");
    expect(lines).toContain("DESCRIPTION:Ouvre Obnixe\\, la séance du jour t'attend.");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(() => remindersIcs({ mask: 0, minutes: 600, from: d("2026-10-25"), stamp: 0 as EpochMs, summary: "x", description: "y", durationMinutes: 30 })).toThrow(RangeError);
  });
});
