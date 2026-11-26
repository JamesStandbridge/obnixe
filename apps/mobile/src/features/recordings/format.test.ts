import { describe, expect, it } from "vitest";
import { climbText, distanceText, effortFigure, effortTitle, paceSeconds, rateFigure, speedFigure } from "@/features/recordings/format";

describe("recorded activity figures", () => {
  it("writes the pace per km or per 100 m, the speed in km/h", () => {
    expect(paceSeconds(10_000_000, 3_000_000, 1000)).toBe(300);
    expect(paceSeconds(0, 3_000_000, 1000)).toBeNull();
    expect(rateFigure({ primary: "pace", pacePerMeters: 1000 }, 10_000_000, 3_000_000)).toEqual({ value: "5:00", unit: "/km" });
    expect(rateFigure({ primary: "pace", pacePerMeters: 100 }, 1_500_000, 1_800_000)).toEqual({ value: "2:00", unit: "/100 m" });
    expect(rateFigure({ primary: "speed", pacePerMeters: 1000 }, 30_000_000, 3_600_000)).toEqual(speedFigure(30_000 / 3600));
    expect(speedFigure(30_000 / 3600)).toEqual({ value: "30,0", unit: "km/h" });
  });

  it("writes distances in km with two decimals below 100 km", () => {
    expect(distanceText(10_254_000)).toEqual({ value: "10,25", unit: "km" });
    expect(distanceText(160_934_000)).toEqual({ value: "160,9", unit: "km" });
  });

  it("names the best efforts and shows their time or ascent", () => {
    expect(effortTitle("run:distance:21097.5")).toBe("Semi-marathon");
    expect(effortTitle("run:distance:400")).toBe("400 m");
    expect(effortTitle("run:distance:5000")).toBe("5 km");
    expect(effortTitle("trail:ascent_1h")).toBe("D+ en 1 h");
    expect(effortFigure({ effort: "run:distance:5000", elapsedMs: 1_234_000, ascentMm: null })).toEqual({ value: "20:34", unit: "" });
    expect(effortFigure({ effort: "trail:ascent_1h", elapsedMs: 3_600_000, ascentMm: 812_400 })).toEqual({ value: "812", unit: "m" });
  });

  it("describes a climb by its start, length, grades, D+, moving time and VAM (GPS-062)", () => {
    const climb = { startDistanceMm: 3_240_000, distanceMm: 2_410_000, ascentMm: 148_300, gradeAvg: 0.0613, gradeMax: 0.112, movingMs: 1_100_000, vamMetersPerHour: 485 };
    expect(climbText(climb)).toEqual({ detail: "Au km 3,2 · 2,41 km à 6,1 % · max 11,2 %", ascent: "+148 m", effort: "18:20 · 485 m/h" });
    expect(climbText({ ...climb, movingMs: 0, vamMetersPerHour: null }).effort).toBe("0:00");
  });
});
