import { describe, expect, it } from "vitest";
import type { ClimbBreakdown, StrengthSummary } from "@obnixe/core";
import { sports } from "@obnixe/schema";
import type { EpochMs, FieldDefinition, FieldValues, Id, LocalDate, Session, SessionItem, SportKey } from "@obnixe/schema";
import {
  choiceLabel,
  climbFacts,
  climbItemText,
  climbItemWord,
  continuousIndicators,
  distanceFigure,
  durationText,
  fieldValueText,
  indicatorFigure,
  indicatorText,
  outcomeText,
  quantityFigure,
  quantityText,
  setsFact,
  timeRange,
} from "@/features/training/sessionText";

const startedAt = Date.UTC(2026, 9, 26, 7, 5) as EpochMs;
const today = "2026-10-26" as LocalDate;

function session(sport: SportKey, values: FieldValues, endedAt: EpochMs | null, pausedSeconds = 0): Session {
  return {
    id: "session" as Id,
    sport,
    slotId: null,
    variantId: null,
    countsInRotation: false,
    gearId: null,
    title: null,
    status: endedAt === null ? "in_progress" : "completed",
    startedAt,
    endedAt,
    pausedSeconds,
    localDate: today,
    timeZone: "Europe/Paris",
    values,
    effort: null,
    sensation: null,
    enjoyment: null,
    note: null,
    review: "skipped",
    deletedAt: null,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
}

function item(values: FieldValues): SessionItem {
  return { id: "item" as Id, sessionId: "session" as Id, position: 0, values, recordedAt: startedAt };
}

function field(sport: SportKey, key: string): FieldDefinition {
  const found = [...sports[sport].sessionFields, ...sports[sport].itemFields].find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`No ${key} field on ${sport}`);
  return found;
}

describe("quantityText", () => {
  it("formats every dimension in French", () => {
    expect(quantityText("distance", 9200, "distance", "kg")).toBe("9,2 km");
    expect(quantityText("distance", 12_345, "distance", "kg")).toBe("12,3 km");
    expect(quantityText("distance", 850, "distance", "kg")).toBe("850 m");
    expect(quantityText("elevation_gain", 1200, "distance", "kg")).toBe("1\u00a0200 m");
    expect(quantityText("pool_length", 25, "distance", "kg")).toBe("25 m");
    expect(quantityText("pack_mass", 12_500, "mass", "kg")).toBe("12,5 kg");
    expect(quantityText("pack_mass", 12_500, "mass", "lb")).toBe("27,6 lb");
    expect(quantityText("waist", 825, "length", "kg")).toBe("82,5 cm");
    expect(quantityText("moving", 3725, "duration", "kg")).toBe("1:02:05");
    expect(quantityText("lengths", 42, "count", "kg")).toBe("42");
    expect(quantityText("heart_rate_avg", 152, "heart_rate", "kg")).toBe("152 bpm");
    expect(quantityText("power_avg", 210, "power", "kg")).toBe("210 W");
  });

  it("splits a distance figure into value and unit", () => {
    expect(distanceFigure(640)).toEqual({ text: "640", unit: "m" });
    expect(distanceFigure(5432)).toEqual({ text: "5,43", unit: "km" });
    expect(distanceFigure(42_195)).toEqual({ text: "42,2", unit: "km" });
  });
});

describe("fieldValueText", () => {
  it("renders each field type and skips values of the wrong shape", () => {
    expect(fieldValueText(field("run", "distance"), 10_000, "kg")).toBe("10 km");
    expect(fieldValueText(field("run", "distance"), "far", "kg")).toBeNull();
    expect(fieldValueText(field("climb", "grade"), "fontainebleau:6B+", "kg")).toBe("6B+");
    expect(fieldValueText(field("climb", "grade"), "fontainebleau:6Z", "kg")).toBeNull();
    expect(fieldValueText(field("run", "kind"), "easy", "kg")).toBe("Footing");
    expect(fieldValueText(field("run", "kind"), "sprint", "kg")).toBe("sprint");
    expect(fieldValueText(field("climb", "style"), ["overhang", "slab"], "kg")).toBe("Dévers, Dalle");
    expect(fieldValueText(field("climb", "style"), [], "kg")).toBeNull();
    expect(fieldValueText(field("hike", "route"), "GR20", "kg")).toBe("GR20");
    expect(fieldValueText(field("hike", "route"), undefined, "kg")).toBeNull();
    const toggle: FieldDefinition = { key: "outdoor", label: "Dehors", type: "toggle", required: false, emphasis: false };
    expect(fieldValueText(toggle, true, "kg")).toBe("Oui");
    expect(fieldValueText(toggle, false, "kg")).toBe("Non");
    expect(choiceLabel(field("hike", "route"), "GR20")).toBe("GR20");
  });
});

describe("indicators", () => {
  it("computes pace and speed from values and the active duration", () => {
    const [runPace] = sports.run.indicators;
    const [swimPace] = sports.swim.indicators;
    const [bikeSpeed] = sports.bike.indicators;
    const [maxSent] = sports.climb.indicators;
    if (runPace === undefined || swimPace === undefined || bikeSpeed === undefined || maxSent === undefined) throw new Error("Missing indicators");
    expect(indicatorText(runPace, { distance: 10_000 }, 3000)).toBe("5:00 /km");
    expect(indicatorText(swimPace, { distance: 2000 }, 2400)).toBe("2:00 /100 m");
    expect(indicatorText(bikeSpeed, { distance: 30_000 }, 3600)).toBe("30 km/h");
    expect(indicatorText(runPace, { distance: 0 }, 3000)).toBeNull();
    expect(indicatorText(runPace, {}, 3000)).toBeNull();
    expect(indicatorText(maxSent, {}, 3000)).toBeNull();
  });

  it("splits indicator and quantity figures into value and unit", () => {
    const [runPace] = sports.run.indicators;
    const [bikeSpeed] = sports.bike.indicators;
    if (runPace === undefined || bikeSpeed === undefined) throw new Error("Missing indicators");
    expect(indicatorFigure(runPace, { distance: 13_000 }, 4800)).toEqual({ text: "6:09", unit: "/km" });
    expect(indicatorFigure(bikeSpeed, { distance: 30_000 }, 3600)).toEqual({ text: "30", unit: "km/h" });
    expect(indicatorFigure(runPace, {}, 3000)).toBeNull();
    expect(quantityFigure("elevation_gain", 580, "distance", "kg")).toEqual({ text: "580", unit: "m" });
    expect(quantityFigure("heart_rate_avg", 151, "heart_rate", "kg")).toEqual({ text: "151", unit: "bpm" });
    expect(quantityFigure("lengths", 40, "count", "kg")).toEqual({ text: "40", unit: "" });
  });

  it("lists the indicators of a finished or running session", () => {
    expect(continuousIndicators(session("run", { distance: 10_000 }, (startedAt + 3300 * 1000) as EpochMs, 300), startedAt)).toEqual(["5:00 /km"]);
    expect(continuousIndicators(session("run", { distance: 5000 }, null), (startedAt + 1500 * 1000) as EpochMs)).toEqual(["5:00 /km"]);
    expect(continuousIndicators(session("yoga", {}, (startedAt + 3600 * 1000) as EpochMs), startedAt)).toEqual([]);
  });
});

describe("times and durations", () => {
  it("writes the wall-clock range and the active duration", () => {
    const finished = session("run", {}, (startedAt + 5400 * 1000) as EpochMs, 600);
    expect(timeRange(finished)).toBe("8:05 – 9:35");
    expect(timeRange(session("run", {}, null))).toBe("8:05");
    expect(durationText(finished, startedAt)).toBe("1 h 20");
    expect(durationText(session("run", {}, null), (startedAt + 45 * 60_000) as EpochMs)).toBe("45 min");
  });
});

describe("climbing", () => {
  it("names items after the discipline", () => {
    expect(climbItemWord(session("climb", { discipline: "lead" }, null))).toEqual({ singular: "voie", plural: "voies" });
    expect(climbItemWord(session("climb", { discipline: "top_rope" }, null)).plural).toBe("voies");
    expect(climbItemWord(session("climb", { discipline: "boulder" }, null)).plural).toBe("blocs");
  });

  it("describes an item by grade, style and result", () => {
    expect(climbItemText(item({ grade: "fontainebleau:6C", attempts: 1, result: "flash", style: ["overhang"] }))).toEqual({ grade: "6C", style: "dévers", result: "flash" });
    expect(climbItemText(item({ grade: "french:6a+", attempts: 3, result: "sent" }))).toEqual({ grade: "6a+", style: "", result: "3 essais" });
    expect(climbItemText(item({ grade: "french:6a+", result: "sent" })).result).toBe("enchaîné");
    expect(climbItemText(item({ grade: "bad", attempts: 4, result: "project" }))).toEqual({ grade: "–", style: "", result: "pas encore · 4" });
  });

  it("sums up a breakdown", () => {
    const breakdown: ClimbBreakdown = { count: 6, sent: 4, flash: 2, maxSent: "6C", groups: [] };
    expect(climbFacts(breakdown, { singular: "bloc", plural: "blocs" })).toEqual(["6 blocs", "max enchaîné 6C", "2 flash"]);
    expect(climbFacts({ ...breakdown, count: 1, flash: 0, maxSent: null }, { singular: "voie", plural: "voies" })).toEqual(["1 voie"]);
  });
});

describe("strength outcomes", () => {
  const previousDate = "2026-10-24" as LocalDate;

  it("explains each outcome against the previous session", () => {
    expect(outcomeText({ kind: "skipped" }, "total", today, "kg", true)).toBe("passé");
    expect(outcomeText({ kind: "stopped", setsDone: 2, setsPlanned: 4 }, "total", today, "kg", true)).toBe("arrêté à la série 3");
    expect(outcomeText({ kind: "suspended" }, "total", today, "kg", true)).toBe("suspendue");
    expect(outcomeText({ kind: "first" }, "total", today, "kg", true)).toBe("première fois");
    expect(outcomeText({ kind: "load", deltaGrams: 2500, previousDate }, "total", today, "kg", true)).toBe("+2,5 kg vs avant-hier");
    expect(outcomeText({ kind: "load", deltaGrams: -5000, previousDate }, "per_hand", today, "kg", false)).toBe("−5 kg au total");
    expect(outcomeText({ kind: "reps", delta: -1, previousDate }, "total", today, "kg", true)).toBe("−1 rép.");
    expect(outcomeText({ kind: "duration", deltaSeconds: 15, previousDate }, "total", today, "kg", true)).toBe("+15 s");
    expect(outcomeText({ kind: "same", previousDate: "2026-10-25" as LocalDate }, "total", today, "kg", true)).toBe("comme hier");
  });

  it("counts done sets against the plan", () => {
    const summary: StrengthSummary = { durationSeconds: 3600, setsDone: 14, setsPlanned: 16, volumeGrams: 0, averageRestSeconds: null, best: null };
    expect(setsFact(summary)).toBe("14 séries sur 16");
    expect(setsFact({ ...summary, setsDone: 1, setsPlanned: null })).toBe("1 série");
  });
});
