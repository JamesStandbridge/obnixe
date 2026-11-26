import { describe, expect, it } from "vitest";
import type { EpochMs, FieldValues, Id, LocalDate } from "@obnixe/schema";
import type { RecordingDigest, SessionSummary } from "./sessions.ts";
import { orderSessions, periodTotals } from "./totals.ts";

function summary(localDate: string, values: FieldValues, durationSeconds: number, recording: RecordingDigest | null = null): SessionSummary {
  return {
    id: localDate as Id,
    sport: "run",
    title: null,
    slotName: null,
    variantName: null,
    localDate: localDate as LocalDate,
    startedAt: Date.parse(`${localDate}T08:00:00Z`) as EpochMs,
    timeZone: "Europe/Paris",
    durationSeconds,
    values,
    items: [],
    effort: null,
    review: "skipped",
    note: null,
    strength: null,
    pains: [],
    addedBy: null,
    recording,
  };
}

const recorded: RecordingDigest = { source: "live", previewPolyline: null, distanceMm: 10_250_000, movingMs: 3_000_000, ascentMm: 120_000, energyKcal: 640 };

describe("period totals (SUM-011, CAL-005)", () => {
  const sessions = [
    summary("2026-11-02", { distance: 8000, elevation_gain: 40 }, 2700),
    summary("2026-11-05", { distance: 10_250 }, 3100, recorded),
    summary("2026-11-20", { distance: 5000 }, 1500),
    summary("2025-12-31", { distance: 21_100 }, 7000),
  ];

  it("adds recorded and hand-logged activities by week, flagging those without energy", () => {
    const weeks = periodTotals(sessions, "week", "2026-11-06" as LocalDate, 2);
    expect(weeks.map((week) => week.from)).toEqual(["2026-10-26", "2026-11-02"]);
    expect(weeks[1]).toEqual({ from: "2026-11-02", to: "2026-11-08", count: 2, distanceMeters: 18_250, movingSeconds: 5700, ascentMeters: 160, energyKcal: 640, withoutEnergy: 1 });
    expect(weeks[0]?.count).toBe(0);
  });

  it("covers whole months and years", () => {
    const months = periodTotals(sessions, "month", "2026-11-27" as LocalDate, 12);
    expect(months).toHaveLength(12);
    expect(months.at(-1)).toMatchObject({ from: "2026-11-01", to: "2026-11-30", count: 3 });
    expect(months[0]).toMatchObject({ from: "2025-12-01", count: 1, distanceMeters: 21_100 });
    const years = periodTotals(sessions, "year", "2026-11-27" as LocalDate, 2);
    expect(years.map((year) => [year.from, year.to, year.count])).toEqual([
      ["2025-01-01", "2025-12-31", 1],
      ["2026-01-01", "2026-12-31", 3],
    ]);
  });
});

describe("journal order (SUM-012)", () => {
  const sessions = [
    summary("2026-11-02", { distance: 8000, elevation_gain: 40 }, 2700),
    summary("2026-11-05", { distance: 10_250 }, 3100, recorded),
    summary("2026-11-20", {}, 1500),
  ];
  const ids = (order: Parameters<typeof orderSessions>[1]): readonly string[] => orderSessions(sessions, order).map((item) => item.id);

  it("sorts by date, then by the measured or logged value, largest first", () => {
    expect(ids("date")).toEqual(["2026-11-20", "2026-11-05", "2026-11-02"]);
    expect(ids("distance")).toEqual(["2026-11-05", "2026-11-02", "2026-11-20"]);
    expect(ids("duration")).toEqual(["2026-11-05", "2026-11-02", "2026-11-20"]);
    expect(ids("ascent")).toEqual(["2026-11-05", "2026-11-02", "2026-11-20"]);
  });
});
