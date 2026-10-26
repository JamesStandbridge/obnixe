import { describe, expect, it } from "vitest";
import type { EpochMs, LocalDate } from "@obnixe/schema";
import { activeSeconds, addDays, isResumable, localDateOf } from "./time.ts";
import { gramsToMass, massStep, massToGrams } from "./units.ts";

const paris = (iso: string): EpochMs => new Date(iso).getTime() as EpochMs;

describe("local dates", () => {
  it("uses the session time zone around midnight", () => {
    expect(localDateOf(paris("2026-10-24T22:30:00Z"), "Europe/Paris")).toBe("2026-10-25");
    expect(localDateOf(paris("2026-10-24T22:30:00Z"), "UTC")).toBe("2026-10-24");
    expect(addDays("2026-12-31" as LocalDate, 1)).toBe("2027-01-01");
  });

  it("keeps an interrupted session resumable until 6 h the next morning", () => {
    const interrupted = { status: "interrupted" as const, localDate: "2026-10-24" as LocalDate, timeZone: "Europe/Paris" };
    expect(isResumable(interrupted, paris("2026-10-24T20:00:00Z"))).toBe(true);
    expect(isResumable(interrupted, paris("2026-10-25T04:59:00Z"))).toBe(true);
    expect(isResumable(interrupted, paris("2026-10-25T05:00:00Z"))).toBe(false);
    expect(isResumable({ ...interrupted, status: "completed" }, paris("2026-10-24T20:00:00Z"))).toBe(false);
  });

  it("measures active time without pauses", () => {
    const startedAt = paris("2026-10-24T13:44:00Z");
    expect(activeSeconds({ startedAt, endedAt: (startedAt + 3_600_000) as EpochMs, pausedSeconds: 120 }, startedAt)).toBe(3480);
    expect(activeSeconds({ startedAt, endedAt: null, pausedSeconds: 0 }, (startedAt + 60_000) as EpochMs)).toBe(60);
  });
});

describe("mass units", () => {
  it("converts grams to kilograms and pounds and back", () => {
    expect(gramsToMass(82_500, "kg")).toBe(82.5);
    expect(gramsToMass(61_235, "lb")).toBe(135);
    expect(massToGrams(135, "lb")).toBe(61_235);
    expect(massToGrams(82.5, "kg")).toBe(82_500);
  });

  it("rounds load steps to plates available in pounds", () => {
    expect(massStep(2500, "kg")).toBe(2.5);
    expect(massStep(2500, "lb")).toBe(5);
    expect(massStep(1000, "lb")).toBe(2.5);
  });
});
