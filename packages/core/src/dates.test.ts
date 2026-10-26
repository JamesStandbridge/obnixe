import { describe, expect, it } from "vitest";
import type { EpochMs, LocalDate } from "@obnixe/schema";
import { addDays, addMonths, daysBetween, daysInMonth, epochAt, InvalidLocalDateError, localDateOf, localTimeOf, mondayOf, weekdayIndex } from "./dates.ts";

const d = (value: string): LocalDate => value as LocalDate;
const zone = "Europe/Paris";

describe("calendar dates", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDays(d("2026-10-31"), 1)).toBe("2026-11-01");
    expect(addDays(d("2027-01-01"), -1)).toBe("2026-12-31");
    expect(addDays(d("2026-03-01"), -1)).toBe("2026-02-28");
    expect(daysBetween(d("2026-02-27"), d("2026-03-02"))).toBe(3);
    expect(daysBetween(d("2026-10-19"), d("2026-10-25"))).toBe(6);
  });

  it("starts weeks on Monday", () => {
    expect(weekdayIndex(d("2026-10-25"))).toBe(6);
    expect(weekdayIndex(d("2026-10-19"))).toBe(0);
    expect(mondayOf(d("2026-10-25"))).toBe("2026-10-19");
    expect(mondayOf(d("2026-10-19"))).toBe("2026-10-19");
  });

  it("walks months", () => {
    expect(addMonths({ year: 2026, month: 1 }, -2)).toEqual({ year: 2025, month: 11 });
    expect(daysInMonth({ year: 2028, month: 2 })).toBe(29);
  });

  it("rejects malformed dates", () => {
    expect(() => addDays(d("25/10/2026"), 1)).toThrow(InvalidLocalDateError);
  });
});

describe("time zones", () => {
  it("derives the local day and time in an explicit time zone", () => {
    const late = Date.UTC(2026, 9, 24, 22, 30) as EpochMs;
    expect(localDateOf(late, zone)).toBe("2026-10-25");
    expect(localDateOf(late, "UTC")).toBe("2026-10-24");
    expect(localTimeOf(late, zone)).toEqual({ date: "2026-10-25", minutes: 30 });
    expect(localTimeOf(Date.UTC(2026, 9, 25, 22, 30) as EpochMs, zone)).toEqual({ date: "2026-10-25", minutes: 23 * 60 + 30 });
  });

  it("converts a wall clock back to an instant across daylight saving changes", () => {
    expect(epochAt({ date: d("2026-10-24"), minutes: 14 * 60 + 30 }, zone)).toBe(Date.UTC(2026, 9, 24, 12, 30));
    expect(epochAt({ date: d("2026-10-26"), minutes: 14 * 60 + 30 }, zone)).toBe(Date.UTC(2026, 9, 26, 13, 30));
  });
});
