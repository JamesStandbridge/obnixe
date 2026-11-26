import { describe, expect, it } from "vitest";
import { defaultRecordingSettings, resolveProfile } from "@obnixe/core";
import type { RecordAnnouncement, RecordingAlertEvent, ResolvedProfile } from "@obnixe/core";
import type { EpochMs, FieldValues, Id, RecordingSettings, SportKey } from "@obnixe/schema";
import { alertNotice, alertPulses, beepWave, heartRateSpanBpm, rejoinText, vibrationPattern } from "@/features/recording/alerts";
import { elevationShape } from "@/features/recording/elevation";
import { cadenceUnit, lapFigures, metricText, summaryFigures } from "@/features/recording/metrics";
import { maxHeartRateDetail, maxHeartRateFrom, zoneLines } from "@/features/recording/physiology";
import { liveReadout, storedReadout, withMetric, withSecondaryAdded, withSecondaryRemoved } from "@/features/recording/readout";
import { effortLabel, recordLines } from "@/features/recording/records";
import { boundsOf, summaryTrack } from "@/features/recording/summaryTrack";
import {
  alertLabel,
  autoLapChoiceOf,
  autoLapLabel,
  autoLapOptions,
  defaultPaceRange,
  isSportKey,
  kmhTenthsToMmS,
  mmSToKmhTenths,
  paceRangeLabel,
  settingsSummary,
  withAlert,
  withZoneEnd,
} from "@/features/recording/settings";
import { slotTarget, targetProgress } from "@/features/recording/target";
import { batteryGuide, batteryVendorOf } from "@/features/tracking/battery";
import { sensorTextsOf } from "@/features/recording/sensorTexts";
import { bluetoothSensorsOf, isSensorRole, sensorRoleOfIssue, sensorServiceOf, signalStrengthOf, withDevice } from "@/features/tracking/sensorDevices";

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

  it("shows what is left of the followed route (RTE-003)", () => {
    const text = (key: Parameters<typeof metricText>[0], value: number) => metricText(key, { [key]: value }, run, noon, "Europe/Paris");
    expect(text("route_remaining", 12_345)).toEqual({ value: "12,3", unit: "km" });
    expect(text("route_remaining", 784)).toEqual({ value: "780", unit: "m" });
    expect(text("route_ascent_remaining", 412.6)).toEqual({ value: "413", unit: "m" });
    expect(text("route_progress", 0.999)).toEqual({ value: "99", unit: "%" });
    expect(metricText("route_progress", {}, run, noon, "Europe/Paris")).toEqual({ value: "–", unit: "%" });
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
  const venu = { id: "C4:7D:2A:10:9E:01", name: "Venu 3S" };

  it("uses annex A, the heart rate taking the last place when a source is memorized (SPT-005)", () => {
    expect(liveReadout(run, none)).toEqual({ main: "pace_now", secondary: ["distance", "moving", "pace_avg", "cadence"] });
    expect(liveReadout(run, { readout: null, heartRateDevice: venu })).toEqual({ main: "pace_now", secondary: ["distance", "moving", "pace_avg", "heart_rate"] });
    const chosen: NonNullable<RecordingSettings["readout"]> = { main: "distance", secondary: ["moving", "heart_rate", "clock"] };
    expect(liveReadout(run, { readout: chosen, heartRateDevice: venu })).toEqual(chosen);
  });

  it("leaves out the metrics the profile does not compute", () => {
    const bike = profileOf("bike", { kind: "road" });
    expect(liveReadout(bike, { readout: { main: "gap_now", secondary: ["distance", "steps", "moving", "speed_avg"] }, heartRateDevice: null })).toEqual({
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
  it("prefers the distance target and counts the moving time for a duration (UX-005, INT-003)", () => {
    const distance = slotTarget({ targetValues: { kind: "long", distance: 18_000 }, targetDurationSeconds: 5400 });
    expect(distance).toEqual({ kind: "distance", meters: 18_000 });
    expect(distance === null ? null : targetProgress(distance, { distanceMm: 12_480_000, movingMs: 0 })).toEqual({ fraction: 12.48 / 18, reached: false, done: "12,4", goal: "18 km" });
    const duration = slotTarget({ targetValues: {}, targetDurationSeconds: 1800 });
    expect(duration === null ? null : targetProgress(duration, { distanceMm: 0, movingMs: 1_830_000 })).toEqual({ fraction: 1, reached: true, done: "30:30", goal: "30:00" });
    expect(slotTarget({ targetValues: {}, targetDurationSeconds: null })).toBeNull();
  });
});

describe("recording alerts", () => {
  const run = profileOf("run");
  const bike = profileOf("bike", { kind: "road" });

  it("says each alert in a few words for the banner and the notification (REC-075)", () => {
    const notice = (event: RecordingAlertEvent, profile: ResolvedProfile = run) => alertNotice(event, profile);
    expect(notice({ kind: "split", index: 3, meters: 1000, movingMs: 285_000 })).toEqual({ title: "Kilomètre 3", detail: "4:45 · 4:45 /km", tone: "mark" });
    expect(notice({ kind: "split", index: 2, meters: 5000, movingMs: 600_000 }, bike).title).toBe("10 km");
    expect(notice({ kind: "pace_range", range: { kind: "pace", fastestSecondsPerKm: 300, slowestSecondsPerKm: 330 }, status: "below", repeat: 0 })).toEqual({ title: "Allure trop lente", detail: "Cible 5:00 – 5:30 /km", tone: "warn" });
    expect(notice({ kind: "pace_range", range: { kind: "speed", minMmS: 6944, maxMmS: 8333 }, status: "back" }, bike)).toEqual({ title: "Vitesse dans la cible", detail: "Cible 25 – 30 km/h", tone: "mark" });
    expect(notice({ kind: "heart_rate_range", range: { lowest: 2, highest: 3 }, status: "above", repeat: 0 })).toEqual({ title: "Cardio trop haut", detail: "Cible Z2 – Z3", tone: "warn" });
    expect(notice({ kind: "goal", goal: { kind: "distance", meters: 10_000 } }).detail).toBe("Objectif 10 km atteint");
    expect(notice({ kind: "gps", change: "lost" }).title).toBe("Signal GPS perdu");
    expect(notice({ kind: "sensor", sensor: "heart_rate", change: "back" })).toEqual({ title: "Capteur cardiaque reconnecté", detail: "La fréquence cardiaque reprend", tone: "mark" });
    expect(notice({ kind: "sensor", sensor: "power", change: "lost" }, bike)).toEqual({ title: "Capteur de puissance perdu", detail: "Reconnexion en cours", tone: "warn" });
    expect(notice({ kind: "sensor", sensor: "cadence", change: "back" }, bike).detail).toBe("La cadence reprend");
    expect(notice({ kind: "battery", level: "critical" }).tone).toBe("stop");
  });

  it("counts an open-water swim per 100 m (SPT-009)", () => {
    const swim = profileOf("swim");
    expect(alertNotice({ kind: "split", index: 3, meters: 100, movingMs: 130_000 }, swim)).toEqual({ title: "300 m", detail: "2:10 · 2:10 /100 m", tone: "mark" });
    expect(alertNotice({ kind: "pace_range", range: defaultPaceRange(swim), status: "below", repeat: 0 }, swim).detail).toBe("Cible 2:00 – 2:30 /100 m");
    expect(paceRangeLabel(defaultPaceRange(swim), swim)).toBe("2:00 – 2:30 /100 m");
    expect(alertLabel("split", swim).detail).toBe("Tous les 100 m, sans tour automatique");
    expect(defaultPaceRange(profileOf("nordic_ski", { kind: "skate" })).kind).toBe("pace");
    expect(defaultPaceRange(profileOf("paddle", { kind: "kayak" })).kind).toBe("speed");
  });

  it("names the segment on entry and gives its time against the best pass at the end (SEG-004)", () => {
    const segmentId = "seg" as Id;
    expect(alertNotice({ kind: "segment_entered", segmentId, name: "Col du Coq", bestElapsedMs: 1_265_000 }, run)).toEqual({ title: "Segment Col du Coq", detail: "Meilleur passage 21:05", tone: "mark" });
    expect(alertNotice({ kind: "segment_entered", segmentId, name: "Col du Coq", bestElapsedMs: null }, run).detail).toBe("Premier passage, chrono lancé");
    const finished = (elapsedMs: number, bestElapsedMs: number | null) => alertNotice({ kind: "segment_finished", segmentId, name: "Col du Coq", elapsedMs, bestElapsedMs }, run);
    expect(finished(3_725_000, 3_737_000)).toEqual({ title: "Col du Coq · 1:02:05", detail: "Meilleur passage, −0:12", tone: "mark" });
    expect(finished(1_330_000, 1_265_000).detail).toBe("+1:05 sur le meilleur passage");
    expect(finished(1_330_000, null).detail).toBe("Premier passage");
    expect(alertPulses({ kind: "segment_entered", segmentId, name: "Col du Coq", bestElapsedMs: null })).toEqual([300, 120, 100]);
    expect(alertPulses({ kind: "segment_finished", segmentId, name: "Col du Coq", elapsedMs: 1, bestElapsedMs: null })).toEqual([100, 120, 100, 120, 300]);
    expect(alertLabel("segment", run).title).toBe("Segments");
  });

  it("says the next step of a guided workout and its target (WKT-006)", () => {
    const work = { index: 3, intent: "work", duration: { kind: "distance", mm: 400_000 }, target: { kind: "pace", fastestSecondsPerKm: 200, slowestSecondsPerKm: 215 }, label: null, repetition: { number: 2, count: 8 } } as const;
    expect(alertNotice({ kind: "workout_step", step: work }, run)).toEqual({ title: "Travail", detail: "Répétition 2/8 · 400 m · 3:20 – 3:35 /km", tone: "mark" });
    expect(alertNotice({ kind: "workout_step", step: { ...work, intent: "recovery", duration: { kind: "time", ms: 90_000 }, target: { kind: "none" }, label: "Trot" } }, run)).toEqual({ title: "Trot", detail: "Répétition 2/8 · 1:30", tone: "mark" });
    expect(alertNotice({ kind: "workout_step", step: null }, run).title).toBe("Séance terminée");
    expect(alertNotice({ kind: "workout_target", step: work, status: "above", repeat: 0 }, run)).toEqual({ title: "Allure trop rapide", detail: "Cible 3:20 – 3:35 /km", tone: "warn" });
    expect(alertNotice({ kind: "workout_target", step: { ...work, target: { kind: "heart_rate_zone", zone: 4 } }, status: "back" }, run)).toEqual({ title: "Cardio dans la cible", detail: "Cible Z4", tone: "mark" });
    expect(alertPulses({ kind: "workout_step", step: null })).toEqual([200, 150, 200]);
  });

  it("points back to the route when off it (RTE-005)", () => {
    expect(rejoinText({ distance: 84, bearing: 130 })).toBe("à 80 m au sud-est");
    expect(rejoinText({ distance: 1520, bearing: -10 })).toBe("à 1,5 km au nord");
    expect(alertNotice({ kind: "route", status: "off", repeat: 0, rejoin: { latitude: 45, longitude: 5, progress: 100, distance: 60, bearing: 270 } }, run)).toEqual({
      title: "Hors itinéraire",
      detail: "L'itinéraire est à 60 m à l'ouest",
      tone: "warn",
    });
    expect(alertNotice({ kind: "route", status: "off", repeat: 1, rejoin: null }, run).detail).toBe("Reviens sur le tracé");
    expect(alertNotice({ kind: "route", status: "back" }, run)).toEqual({ title: "De retour sur l'itinéraire", detail: "Le suivi reprend", tone: "mark" });
    expect(alertLabel("route", run).title).toBe("Sortie d'itinéraire");
  });

  it("tells alerts apart by their vibration, on both systems (REC-075)", () => {
    expect(alertPulses({ kind: "split", index: 1, meters: 1000, movingMs: 300_000 })).toEqual([200]);
    expect(alertPulses({ kind: "goal", goal: { kind: "duration", seconds: 1800 } })).toEqual([200, 150, 200]);
    const out = alertPulses({ kind: "heart_rate_range", range: { lowest: 2, highest: 2 }, status: "above", repeat: 1 });
    expect(out).toEqual([100, 120, 100, 120, 100]);
    expect(vibrationPattern(out, "android")).toEqual([0, 100, 120, 100, 120, 100]);
    expect(vibrationPattern(out, "ios")).toEqual([0, 520, 520]);
    expect(vibrationPattern([200], "ios")).toEqual([0]);
  });

  it("shows a heart-rate span in bpm only with a maximum", () => {
    expect(heartRateSpanBpm({ lowest: 2, highest: 3 }, 190)).toBe("114 – 152 bpm");
    expect(heartRateSpanBpm({ lowest: 4, highest: 5 }, 190)).toBe("dès 152 bpm");
    expect(heartRateSpanBpm({ lowest: 2, highest: 3 }, null)).toBeNull();
  });

  it("builds the beep as a mono 16-bit WAV with silent edges", () => {
    const wave = beepWave(100, 880);
    const view = new DataView(wave.buffer);
    const text = (offset: number) => String.fromCharCode(...wave.subarray(offset, offset + 4));
    expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint32(24, true)).toBe(22_050);
    expect(view.getUint32(40, true)).toBe(2205 * 2);
    expect(wave.length).toBe(44 + 2205 * 2);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(wave.length - 2, true)).toBe(0);
  });
});

describe("recording settings", () => {
  const run = profileOf("run");
  const bike = profileOf("bike", { kind: "road" });
  const base = defaultRecordingSettings(run);

  it("switches one alert type off and back on (REC-075)", () => {
    const off = withAlert(base, "split", false);
    expect(off.alerts.disabled).toEqual(["split"]);
    expect(withAlert(withAlert(off, "gps", false), "split", true).alerts.disabled).toEqual(["gps"]);
  });

  it("offers the automatic laps of the schema and finds the chosen one (REC-030)", () => {
    expect(autoLapOptions[0]).toEqual({ value: "none", label: "Aucun", autoLap: null });
    expect(autoLapOptions.map((option) => option.value)).toContain("distance:1000");
    expect(autoLapChoiceOf({ trigger: "duration", ms: 300_000 })).toBe("duration:300000");
    expect(autoLapLabel({ trigger: "distance", meters: 400 })).toBe("Tous les 400 m");
    expect(autoLapLabel({ trigger: "distance", meters: 5000 })).toBe("Tous les 5 km");
    expect(autoLapLabel({ trigger: "duration", ms: 600_000 })).toBe("Toutes les 10 min");
  });

  it("starts a span from the sport's measure and keeps a heart-rate span ordered", () => {
    expect(defaultPaceRange(run)).toEqual({ kind: "pace", fastestSecondsPerKm: 300, slowestSecondsPerKm: 360 });
    expect(defaultPaceRange(profileOf("walk"))).toEqual({ kind: "pace", fastestSecondsPerKm: 600, slowestSecondsPerKm: 720 });
    expect(paceRangeLabel(defaultPaceRange(profileOf("hike")), run)).toBe("3,0 – 5,0 km/h");
    expect(paceRangeLabel(defaultPaceRange(bike), bike)).toBe("25,0 – 30,0 km/h");
    expect(mmSToKmhTenths(kmhTenthsToMmS(275))).toBe(275);
    expect(withZoneEnd({ lowest: 2, highest: 3 }, "lowest", 4)).toEqual({ lowest: 4, highest: 4 });
    expect(withZoneEnd({ lowest: 3, highest: 4 }, "highest", 2)).toEqual({ lowest: 2, highest: 2 });
  });

  it("sums up what departs from the defaults (DAT-003)", () => {
    expect(settingsSummary(run, base)).toBe("pause auto");
    const changed: RecordingSettings = { ...withAlert(withAlert(base, "gps", false), "battery", false), autoPause: false, autoLap: { trigger: "distance", meters: 1000 }, heartRateDevice: { id: "C4:7D", name: "Venu 3S" } };
    expect(settingsSummary(run, changed)).toBe("sans pause auto · tours tous les 1 km · 2 alertes coupées · Venu 3S");
    const stryd = { id: "D0:5F", name: "Stryd" };
    const paired: RecordingSettings = { ...changed, cadenceDevice: stryd, powerDevice: stryd };
    expect(settingsSummary(run, paired)).toBe("sans pause auto · tours tous les 1 km · 2 alertes coupées · Venu 3S · Stryd");
    expect(settingsSummary(profileOf("swim"), paired)).toBe("sans pause auto · tours tous les 1 km · 2 alertes coupées");
    expect(isSportKey("run")).toBe(true);
    expect(isSportKey("chess")).toBe(false);
  });
});

describe("Bluetooth sources", () => {
  it("lists each source once, strongest first, keeping a name an advertisement left out (SPT-007)", () => {
    const venu = { service: "heart_rate", id: "C4:7D", name: "Venu 3S", rssi: -78 } as const;
    const strap = { service: "heart_rate", id: "E1:02", name: "HRM-Pro", rssi: -60 } as const;
    const listed = withDevice(withDevice(withDevice([], venu), strap), { service: "heart_rate", id: "C4:7D", name: "", rssi: -52 });
    expect(listed).toEqual([{ service: "heart_rate", id: "C4:7D", name: "Venu 3S", rssi: -52 }, strap]);
    expect([signalStrengthOf(-52), signalStrengthOf(-78), signalStrengthOf(-90)]).toEqual(["strong", "medium", "weak"]);
  });

  it("reads a footpod on foot and a crank sensor on the bike, and connects only what the profile pairs (SPT-008)", () => {
    const run = profileOf("run");
    const bike = profileOf("bike", { kind: "road" });
    expect([sensorServiceOf("cadence", run), sensorServiceOf("cadence", bike), sensorServiceOf("power", run), sensorServiceOf("heart_rate", bike)]).toEqual([
      "running_speed_cadence",
      "cycling_speed_cadence",
      "cycling_power",
      "heart_rate",
    ]);
    const settings: RecordingSettings = { ...defaultRecordingSettings(bike), heartRateDevice: { id: "C4:7D", name: "Venu 3S" }, cadenceDevice: { id: "F2:10", name: "Cadence" }, powerDevice: { id: "A9:33", name: "Assioma" } };
    expect(bluetoothSensorsOf(bike, settings)).toEqual([
      { service: "heart_rate", id: "C4:7D" },
      { service: "cycling_speed_cadence", id: "F2:10" },
      { service: "cycling_power", id: "A9:33" },
    ]);
    expect(bluetoothSensorsOf(profileOf("paddle"), settings)).toEqual([{ service: "heart_rate", id: "C4:7D" }]);
    expect(bluetoothSensorsOf(profileOf("swim"), settings)).toEqual([]);
    expect([sensorRoleOfIssue("power_lost"), sensorRoleOfIssue("cadence_lost"), sensorRoleOfIssue("storage_low")]).toEqual(["power", "cadence", null]);
    expect([isSensorRole("power"), isSensorRole("speed"), isSensorRole(undefined)]).toEqual([true, false, false]);
  });

  it("names each source and its unit in the sport's words (SPT-008)", () => {
    const run = profileOf("run");
    const bike = profileOf("bike", { kind: "road" });
    expect([sensorTextsOf("cadence", run).none, sensorTextsOf("cadence", bike).none, sensorTextsOf("power", bike).none]).toEqual(["Aucun · footpod, sinon le téléphone", "Aucun · capteur de pédalier", "Aucun · pédales, manivelle ou moyeu"]);
    expect([cadenceUnit(run), cadenceUnit(bike)]).toEqual(["pas/min", "tr/min"]);
    expect(metricText("cadence", { cadence: 88 }, bike, noon, "Europe/Paris")).toEqual({ value: "88", unit: "tr/min" });
    expect(alertLabel("sensor", bike).title).toBe("Capteurs Bluetooth");
    expect(alertLabel("sensor", profileOf("alpine_ski")).title).toBe("Capteur cardiaque");
  });
});

describe("physiology", () => {
  it("prefers the entered maximum to the Tanaka estimate (CAL-004)", () => {
    const estimated = maxHeartRateFrom({ birthYear: 1986, sex: "female", maxHeartRate: null }, noon);
    expect(estimated).toEqual({ kind: "estimated", bpm: 180, age: 40 });
    expect(maxHeartRateDetail(estimated)).toBe("Estimée à 40 ans : 208 − 0,7 × âge");
    expect(maxHeartRateFrom({ birthYear: 1986, sex: null, maxHeartRate: 192 }, noon)).toEqual({ kind: "entered", bpm: 192 });
    expect(maxHeartRateFrom({ birthYear: null, sex: null, maxHeartRate: null }, noon)).toEqual({ kind: "unknown" });
    expect(zoneLines(180).map((line) => `${line.label} ${line.bpm}`)).toEqual(["Z1 · 50 à 60 % 90–108", "Z2 · 60 à 70 % 108–126", "Z3 · 70 à 80 % 126–144", "Z4 · 80 à 90 % 144–162", "Z5 · 90 à 100 % 162–180"]);
  });
});

describe("battery help", () => {
  it("recognizes the systems that stop background services (PLT-011)", () => {
    expect(batteryVendorOf("Xiaomi", "android")).toBe("xiaomi");
    expect(batteryVendorOf("POCO", "android")).toBe("xiaomi");
    expect(batteryVendorOf("HONOR", "android")).toBe("huawei");
    expect(batteryVendorOf("realme", "android")).toBe("oppo");
    expect(batteryVendorOf("Google", "android")).toBe("android");
    expect(batteryVendorOf(null, "ios")).toBe("ios");
    expect(batteryGuide("samsung").aggressive).toBe(true);
    expect(batteryGuide("android").aggressive).toBe(false);
    expect(batteryGuide("xiaomi").steps.length).toBeGreaterThan(1);
  });
});

describe("elevation profile", () => {
  it("scales the climb into the box and keeps a flat outing flat (UX-002)", () => {
    const shape = elevationShape(
      [
        { distance: 0, altitude: 200 },
        { distance: 500, altitude: 300 },
        { distance: 1000, altitude: 250 },
      ],
      100,
      50,
    );
    expect(shape?.line).toBe("M0.0 50.0 L50.0 0.0 L100.0 25.0");
    expect(shape?.area.endsWith("L100 50 L0 50 Z")).toBe(true);
    expect(shape?.last).toEqual({ x: 100, y: 25 });
    expect(shape?.meters).toBe(1000);
    const flat = elevationShape(
      [
        { distance: 0, altitude: 100 },
        { distance: 1000, altitude: 104 },
      ],
      100,
      40,
    );
    expect(flat?.line).toBe("M0.0 22.0 L100.0 18.0");
    expect(elevationShape([{ distance: 0, altitude: 100 }], 100, 40)).toBeNull();
  });

  it("places the position on a route's profile (RTE-003)", () => {
    const points = [
      { distance: 0, altitude: 200 },
      { distance: 500, altitude: 300 },
      { distance: 1000, altitude: 250 },
    ];
    expect(elevationShape(points, 100, 50)?.marker).toBeNull();
    expect(elevationShape(points, 100, 50, 250)?.marker).toEqual({ x: 25, y: 25 });
    expect(elevationShape(points, 100, 50, 4000)?.marker).toEqual({ x: 100, y: 25 });
  });
});
