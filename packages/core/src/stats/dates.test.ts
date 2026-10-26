import { describe, expect, it } from "vitest";
import type { EpochMs, LocalDate } from "@obnixe/schema";
import { addDays, addMonths, daysBetween, daysInMonth, InvalidLocalDateError, localClock, mondayOf, weekdayIndex } from "./dates.ts";
import { movingAverage, recordFlags, trend, weeklyTotals } from "./series.ts";

const d = (value: string): LocalDate => value as LocalDate;

describe("local dates", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDays(d("2026-10-31"), 1)).toBe("2026-11-01");
    expect(addDays(d("2027-01-01"), -1)).toBe("2026-12-31");
    expect(daysBetween(d("2026-02-27"), d("2026-03-02"))).toBe(3);
  });

  it("starts weeks on Monday", () => {
    expect(weekdayIndex(d("2026-10-25"))).toBe(6);
    expect(mondayOf(d("2026-10-25"))).toBe("2026-10-19");
    expect(mondayOf(d("2026-10-19"))).toBe("2026-10-19");
  });

  it("walks months", () => {
    expect(addMonths({ year: 2026, month: 1 }, -2)).toEqual({ year: 2025, month: 11 });
    expect(daysInMonth({ year: 2028, month: 2 })).toBe(29);
  });

  it("reads the wall clock of a time zone across DST", () => {
    expect(localClock(Date.UTC(2026, 9, 24, 22, 30) as EpochMs, "Europe/Paris")).toEqual({ date: "2026-10-25", minutes: 30 });
    expect(localClock(Date.UTC(2026, 9, 25, 22, 30) as EpochMs, "Europe/Paris")).toEqual({ date: "2026-10-25", minutes: 23 * 60 + 30 });
  });

  it("rejects malformed dates", () => {
    expect(() => addDays(d("25/10/2026"), 1)).toThrow(InvalidLocalDateError);
  });
});

describe("series", () => {
  const points = [
    { date: d("2026-09-01"), value: 100, unreliable: false },
    { date: d("2026-09-08"), value: 104, unreliable: false },
    { date: d("2026-09-15"), value: 110, unreliable: true },
    { date: d("2026-09-22"), value: 103, unreliable: false },
    { date: d("2026-09-29"), value: 106, unreliable: false },
  ];

  it("flags strict records, ignoring unreliable points", () => {
    expect(recordFlags(points, "higher")).toEqual([false, true, false, false, true]);
    expect(recordFlags(points, "lower")).toEqual([false, false, false, false, false]);
    expect(recordFlags(points, null)).toEqual([false, false, false, false, false]);
  });

  it("measures the regression change over the covered span", () => {
    const linear = [0, 7, 14, 21].map((offset) => ({ date: addDays(d("2026-09-01"), offset), value: 50 + offset, unreliable: false }));
    expect(trend(linear)).toBeCloseTo(21);
    expect(trend(points.slice(0, 2))).toBeNull();
  });

  it("buckets values per week and smooths averages", () => {
    const weeks = weeklyTotals(d("2026-10-07"), d("2026-10-20"), [
      { date: d("2026-10-06"), value: 8 },
      { date: d("2026-10-11"), value: 4 },
      { date: d("2026-10-13"), value: 6 },
    ]);
    expect(weeks).toEqual([
      { monday: "2026-10-05", value: 12, count: 2 },
      { monday: "2026-10-12", value: 6, count: 1 },
      { monday: "2026-10-19", value: 0, count: 0 },
    ]);
    expect(movingAverage([{ date: d("2026-10-01"), value: 70 }, { date: d("2026-10-05"), value: 72 }, { date: d("2026-10-09"), value: 74 }], 7).map((item) => item.value)).toEqual([70, 71, 73]);
  });
});
