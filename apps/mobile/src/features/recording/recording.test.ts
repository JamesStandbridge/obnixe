import { describe, expect, it } from "vitest";
import { resolveProfile } from "@obnixe/core";
import type { RecordAnnouncement, ResolvedProfile } from "@obnixe/core";
import type { EpochMs, FieldValues, RecordingSettings, SportKey } from "@obnixe/schema";
import { lapFigures, metricText, summaryFigures } from "@/features/recording/metrics";
import { liveReadout, storedReadout, withMetric, withSecondaryAdded, withSecondaryRemoved } from "@/features/recording/readout";
import { effortLabel, recordLines } from "@/features/recording/records";
import { boundsOf, summaryTrack } from "@/features/recording/summaryTrack";
import { slotTarget, targetProgress } from "@/features/recording/target";

function profileOf(sport: SportKey, values: FieldValues = {}): ResolvedProfile {
  const profile = resolveProfile(sport, values);
  if (profile === null) throw new Error(`${sport} records no track`);
  return profile;
}

const noon = Date.UTC(2026, 10, 27, 11, 5) as EpochMs;

describe("live metrics", () => {
  const run = profileOf("run");

  it("writes French units without width jumps on the distance (SPT-006)", () => {
    const text = (key: Parameters<typeof metricText>[0], value: number) => metricText(key, { [key]: value }, run, noon, "Europe/Paris");
    expect(text("distance", 850.7)).toEqual({ value: "850", unit: "m" });
    expect(text("distance", 12_345.9)).toEqual({ value: "12,34", unit: "km" });
    expect(text("distance", 3000)).toEqual({ value: "3,00", unit: "km" });
    expect(text("pace_now", 312)).toEqual({ value: "5:12", unit: "/km" });
    expect(text("speed_now", 6.25)).toEqual({ value: "22,5", unit: "km/h" });
    expect(text("moving", 3_725_000)).toEqual({ value: "1:02:05", unit: "" });
    expect(text("grade_now", -0.082)).toEqual({ value: "−8", unit: "%" });
    expect(text("vertical_speed", 0.2)).toEqual({ value: "+720", unit: "m/h" });
    expect(text("ascent", 1245.4)).toEqual({ value: "1\u00a0245", unit: "m" });
    expect(text("gps_quality", 4.2)).toEqual({ value: "±4", unit: "m" });
    expect(text("heart_rate_zone", 3)).toEqual({ value: "Z3", unit: "" });
    expect(metricText("clock", {}, run, noon, "Europe/Paris").value).toBe("12:05");
  });

  it("shows a placeholder when a value is missing, such as the pace while still", () => {
    expect(metricText("pace_now", {}, run, noon, "Europe/Paris")).toEqual({ value: "–:––", unit: "/km" });
    expect(metricText("heart_rate", {}, run, noon, "Europe/Paris")).toEqual({ value: "–", unit: "bpm" });
  });

  it("sums up a lap with its pace or speed (REC-040)", () => {
    expect(lapFigures({ index: 2, startMs: 600_000, elapsedMs: 290_000, movingMs: 280_000, distanceMm: 1_000_000 }, run)).toEqual({
      title: "Tour 3",
      duration: "4:50",
      distance: { value: "1,00", unit: "km" },
      rate: { value: "4:40", unit: "/km" },
    });
    expect(lapFigures({ index: 0, startMs: 0, elapsedMs: 600_000, movingMs: 600_000, distanceMm: 5_000_000 }, profileOf("bike", { kind: "road" })).rate).toEqual({ value: "30,0", unit: "km/h" });
  });

  it("sums up the activity with only the values that were measured (REC-050)", () => {
    const base = { elapsedMs: 3_000_000, movingMs: 2_700_000, distanceMm: 10_000_000, ascentMm: null, heartRateAvg: null, cadenceAvg: null };
    expect(summaryFigures(base, run)).toEqual({
      distance: { value: "10,00", unit: "km" },
      moving: "45:00",
      stats: [
        { label: "Temps total", value: "50:00", unit: "" },
        { label: "Allure moy.", value: "4:30", unit: "/km" },
      ],
    });
    expect(summaryFigures({ ...base, ascentMm: 120_400, heartRateAvg: 151.6 }, profileOf("bike", { kind: "road" })).stats.map((stat) => `${stat.label} ${stat.value}`)).toEqual([
      "Temps total 50:00",
      "Vitesse moy. 13,3",
      "D+ 120",
      "FC moy. 152",
    ]);
  });
});

describe("live readout", () => {
  const run = profileOf("run");
  const none = { readout: null, heartRateDevice: null } as const;

  it("uses annex A, the heart rate taking the last place when a source is memorized (SPT-005)", () => {
    expect(liveReadout(run, none)).toEqual({ main: "pace_now", secondary: ["distance", "moving", "pace_avg", "cadence"] });
    expect(liveReadout(run, { readout: null, heartRateDevice: "Venue 3S" })).toEqual({ main: "pace_now", secondary: ["distance", "moving", "pace_avg", "heart_rate"] });
    const chosen: NonNullable<RecordingSettings["readout"]> = { main: "distance", secondary: ["moving", "heart_rate", "clock"] };
    expect(liveReadout(run, { readout: chosen, heartRateDevice: "Venue 3S" })).toEqual(chosen);
  });

  it("leaves out the metrics the profile does not compute", () => {
    const bike = profileOf("bike", { kind: "road" });
    expect(liveReadout(bike, { readout: { main: "cadence", secondary: ["distance", "steps", "moving", "speed_avg"] }, heartRateDevice: null })).toEqual({
      main: bike.readout.main,
      secondary: ["distance", "moving", "speed_avg"],
    });
  });

  it("swaps a metric already shown and keeps three to five secondary metrics", () => {
    const readout = liveReadout(run, none);
    expect(withMetric(readout, { kind: "main" }, "distance")).toEqual({ main: "distance", secondary: ["pace_now", "moving", "pace_avg", "cadence"] });
    expect(withMetric(readout, { kind: "secondary", index: 3 }, "heart_rate")).toEqual({ main: "pace_now", secondary: ["distance", "moving", "pace_avg", "heart_rate"] });
    const full = withSecondaryAdded(readout, "ascent");
    expect(full?.secondary).toEqual(["distance", "moving", "pace_avg", "cadence", "ascent"]);
    expect(full === null ? null : withSecondaryAdded(full, "clock")).toBeNull();
    expect(withSecondaryAdded(readout, "distance")).toBeNull();
    const fewer = withSecondaryRemoved(readout, 0);
    expect(fewer?.secondary).toEqual(["moving", "pace_avg", "cadence"]);
    expect(fewer === null ? null : withSecondaryRemoved(fewer, 0)).toBeNull();
  });

  it("stores the default readout as none", () => {
    expect(storedReadout(run, { heartRateDevice: null }, liveReadout(run, none))).toBeNull();
    const changed = withMetric(liveReadout(run, none), { kind: "main" }, "moving");
    expect(storedReadout(run, { heartRateDevice: null }, changed)).toEqual(changed);
  });
});

describe("record announcements", () => {
  it("names the reference distances", () => {
    expect(effortLabel("run:distance:400")).toBe("400 m");
    expect(effortLabel("run:distance:10000")).toBe("10 km");
    expect(effortLabel("run:distance:1609.344")).toBe("1 mile");
    expect(effortLabel("run:distance:21097.5")).toBe("semi-marathon");
    expect(effortLabel("trail:ascent_1h")).toBe("D+ en 1 h");
  });

  it("announces records with their gap and groups first efforts (PR-004)", () => {
    const announcements: RecordAnnouncement[] = [
      { effort: "run:distance:1000", rank: 1, elapsedMs: 240_000, ascentMm: null, best: null },
      { effort: "run:distance:5000", rank: 1, elapsedMs: 1_200_000, ascentMm: null, best: null },
      { effort: "run:distance:10000", rank: 1, elapsedMs: 2_652_000, ascentMm: null, best: { elapsedMs: 2_690_000, ascentMm: null } },
      { effort: "run:distance:42195", rank: 2, elapsedMs: 13_000_000, ascentMm: null, best: { elapsedMs: 12_600_000, ascentMm: null } },
      { effort: "trail:ascent_1h", rank: 1, elapsedMs: 3_600_000, ascentMm: 950_400, best: { elapsedMs: 3_600_000, ascentMm: 900_000 } },
    ];
    expect(recordLines(announcements)).toEqual([
      { key: "run:distance:10000", title: "Record sur 10 km", detail: "44:12, −0:38", record: true },
      { key: "run:distance:42195", title: "2e meilleur temps au marathon", detail: "3:36:40, +6:40", record: false },
      { key: "trail:ascent_1h", title: "Record de D+ en 1 h", detail: "950 m, +50 m", record: true },
      { key: "firsts", title: "Premiers temps de référence", detail: "1 km 4:00 · 5 km 20:00", record: false },
    ]);
  });
});

describe("summary track", () => {
  it("draws the simplified line with its start and finish, and frames the bounding box (REC-050)", () => {
    const latitude = Float64Array.from({ length: 200 }, (_, index) => 45.2 + index * 0.0001);
    const longitude = Float64Array.from({ length: 200 }, () => 5.7);
    const drawn = summaryTrack({ length: 200, latitude, longitude });
    if (drawn === null) throw new Error("two positions draw a track");
    const line = JSON.parse(drawn.track) as { features: { geometry: { coordinates: number[][] } }[] };
    expect(line.features[0]?.geometry.coordinates).toEqual([
      [5.7, 45.2],
      [5.7, 45.2199],
    ]);
    const points = JSON.parse(drawn.points) as { features: { properties: { kind: string } }[] };
    expect(points.features.map((feature) => feature.properties.kind)).toEqual(["start", "position"]);
    expect(summaryTrack({ length: 1, latitude: latitude.subarray(0, 1), longitude: longitude.subarray(0, 1) })).toBeNull();
    expect(boundsOf({ south: 452_000_000, west: 57_000_000, north: 452_100_000, east: 57_200_000 })).toEqual([5.7, 45.2, 5.72, 45.21]);
  });
});

describe("slot target", () => {
  it("prefers the distance target and counts the moving time for a duration (UX-005)", () => {
    const distance = slotTarget({ targetValues: { kind: "long", distance: 18_000 }, targetDurationSeconds: 5400 });
    expect(distance).toEqual({ kind: "distance", meters: 18_000 });
    expect(distance === null ? null : targetProgress(distance, { distanceMm: 12_480_000, movingMs: 0 })).toEqual({ fraction: 12.48 / 18, reached: false, done: "12,4", goal: "18 km" });
    const duration = slotTarget({ targetValues: {}, targetDurationSeconds: 1800 });
    expect(duration === null ? null : targetProgress(duration, { distanceMm: 0, movingMs: 1_830_000 })).toEqual({ fraction: 1, reached: true, done: "30:30", goal: "30:00" });
    expect(slotTarget({ targetValues: {}, targetDurationSeconds: null })).toBeNull();
  });
});
