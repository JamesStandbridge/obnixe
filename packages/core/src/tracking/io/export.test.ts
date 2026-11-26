import { readFileSync } from "node:fs";
import { Decoder, Stream } from "@garmin/fitsdk";
import { beforeEach, describe, expect, it } from "vitest";
import type { EpochMs, Id, SportKey } from "@obnixe/schema";
import { fixtures } from "../../data/testFixtures.ts";
import type { Fixtures } from "../../data/testFixtures.ts";
import { trashMutation } from "../../data/trash.ts";
import { updateSettings } from "../../settings.ts";
import { createTestContext } from "../../testing.ts";
import type { TestContext } from "../../testing.ts";
import { ellipsoidDistance } from "../geo.ts";
import { exportPrivacyMask, newPrivacyZone } from "../privacyZones.ts";
import { coreScenarios, stageScenarios } from "../testing/scenarios.ts";
import { runBatch, trackOf, untrimmed } from "../testing/run.ts";
import type { ImportedActivity } from "./activity.ts";
import { exportActivity, exportFileName, exportFit, exportGpx, exportTcx } from "./export.ts";
import type { ActivityExportInput, ExportFormat } from "./export.ts";
import { readFit } from "./fit.ts";
import { readGpx } from "./gpx.ts";
import { computeImport } from "./import.ts";
import type { ImportComputation } from "./import.ts";
import { fitSport, fitSportOf, fitSubSport, sportOfFit, tcxSportOf } from "./sports.ts";
import type { FitSportPair, SportGuess } from "./sports.ts";
import { readTcx } from "./tcx.ts";
import { readActivityFile } from "./zip.ts";

const fixtureDirectory = new URL("../../../test/fixtures/import/", import.meta.url);
const activityOf = (name: string): ImportedActivity => readActivityFile(new Uint8Array(readFileSync(new URL(name, fixtureDirectory))));
const encoder = new TextEncoder();

function computed(name: string): ImportComputation {
  const activity = activityOf(name);
  if (activity.sport === null) throw new Error(`${name} has no sport`);
  return computeImport(activity, activity.sport);
}

function inputOf(computation: ImportComputation, overrides: Partial<ActivityExportInput> = {}): ActivityExportInput {
  return { track: computation.track, processed: computation.processed, trim: untrimmed, sport: computation.sport.sport, values: computation.sport.values, title: null, mask: null, energyKcal: null, ...overrides };
}

function exportOf(computation: ImportComputation, overrides: Partial<ActivityExportInput> = {}): string {
  return exportGpx(inputOf(computation, overrides));
}

const reread = (computation: ImportComputation, format: ExportFormat, overrides: Partial<ActivityExportInput> = {}): ImportedActivity => readActivityFile(exportActivity(inputOf(computation, overrides), format));

let context: TestContext;
let make: Fixtures;

beforeEach(() => {
  context = createTestContext();
  make = fixtures(context);
});

describe("GPX export (IO-001, IO-002)", () => {
  it("writes the retained fixes at their original instants, one segment per continuous part", () => {
    const computation = computed("venu3s-run.fit");
    const gpx = exportOf(computation, { title: "Sortie du matin" });
    expect(gpx).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
    expect(gpx).toContain('xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2"');
    expect(gpx).toContain("<type>run</type>");
    expect(gpx.match(/<trkseg>/g)).toHaveLength(2);
    expect(gpx).toMatch(/<trkpt lat="45\.\d{7}" lon="6\.\d{7}"><ele>\d+\.\d<\/ele><time>2026-11-20T\d\d:\d\d:\d\d\.\d{3}Z<\/time>/);
    const back = readGpx(encoder.encode(gpx));
    expect(back.name).toBe("Sortie du matin");
    expect(back.sport?.sport).toBe("run");
    expect(back.startedAt).toBe(computation.activity.startedAt);
    const original = computation.activity.points;
    expect(back.points.length).toBe(computation.processed?.series.length);
    back.points.forEach((point) => {
      const source = original.find((candidate) => candidate.t === point.t);
      expect(source).toBeDefined();
      expect(point.latitudeE7).toBe(source?.latitudeE7);
      expect(point.longitudeE7).toBe(source?.longitudeE7);
      expect(point.heartRate).toBe(source?.heartRate);
    });
    expect(back.marks.map((mark) => mark.kind)).toEqual(["start", "pause", "resume", "stop"]);
  });

  it("exports every fix of a sport without a profile, cut at the pauses", () => {
    const activity = activityOf("multi-track.gpx");
    const swim = computeImport(activity, { sport: "swim", values: { water: "pool" } });
    expect(swim.processed).toBeNull();
    const back = readGpx(encoder.encode(exportOf(swim)));
    expect(back.points).toHaveLength(activity.points.length);
    expect(back.marks.map((mark) => mark.kind)).toEqual(["start", "pause", "resume", "stop"]);
    expect(back.points[0]?.speedMmS).toBe(activity.points[0]?.speedMmS);
  });

  it("applies the trim", () => {
    const computation = computed("garmin-connect-run.gpx");
    const gpx = exportGpx(inputOf(computation, { processed: null, trim: { startMs: 60_000, endMs: 120_000 } }));
    const back = readGpx(encoder.encode(gpx));
    expect(back.startedAt).toBe(computation.activity.startedAt + 60_000);
    expect(back.points.at(-1)?.t).toBe(60_000);
  });

  it.each(["steadyRun", "stopAndGo", "tunnel90s", "forestCanopy", "sawtooth", "steepClimb"] as const)("gives back the distance, moving time and ascent of %s when imported again", (name) => {
    const scenario = name === "sawtooth" || name === "steepClimb" ? stageScenarios[name](3) : coreScenarios[name](3);
    const processed = runBatch(scenario);
    const gpx = exportGpx({ track: trackOf(scenario.samples), processed, trim: untrimmed, sport: scenario.sport, values: {}, title: null, mask: null, energyKcal: null });
    const reimported = computeImport(readGpx(encoder.encode(gpx)), { sport: scenario.sport, values: {} }).summary;
    const { summary } = processed;
    expect(Math.abs(reimported.distanceMm - summary.distanceMm)).toBeLessThanOrEqual(summary.distanceMm / 1000);
    expect(Math.abs(reimported.movingMs - summary.movingMs)).toBeLessThanOrEqual(1000);
    expect(Math.abs((reimported.ascentMm ?? 0) - (summary.ascentMm ?? 0))).toBeLessThanOrEqual(1000);
  });
});

const scenarioNames = ["steadyRun", "stopAndGo", "tunnel90s", "forestCanopy", "sawtooth", "steepClimb"] as const;
type ScenarioName = (typeof scenarioNames)[number];

function reimportDifference(name: ScenarioName, format: ExportFormat): { readonly distanceRatio: number; readonly movingMs: number; readonly ascentMm: number } {
  const scenario = name === "sawtooth" || name === "steepClimb" ? stageScenarios[name](3) : coreScenarios[name](3);
  const processed = runBatch(scenario);
  const bytes = exportActivity({ track: trackOf(scenario.samples), processed, trim: untrimmed, sport: scenario.sport, values: {}, title: null, mask: null, energyKcal: null }, format);
  const reimported = computeImport(readActivityFile(bytes), { sport: scenario.sport, values: {} }).summary;
  const { summary } = processed;
  return {
    distanceRatio: Math.abs(reimported.distanceMm - summary.distanceMm) / summary.distanceMm,
    movingMs: Math.abs(reimported.movingMs - summary.movingMs),
    ascentMm: Math.abs((reimported.ascentMm ?? 0) - (summary.ascentMm ?? 0)),
  };
}

function decodedFit(bytes: Uint8Array): ReturnType<Decoder["read"]>["messages"] {
  expect(new Decoder(Stream.fromByteArray(Array.from(bytes))).checkIntegrity()).toBe(true);
  const { messages, errors } = new Decoder(Stream.fromByteArray(Array.from(bytes))).read({ convertDateTimesToDates: false });
  expect(errors).toEqual([]);
  return messages;
}

const absoluteTimes = (activity: ImportedActivity): readonly number[] => activity.points.map((point) => activity.startedAt + point.t);

describe("FIT export (IO-003)", () => {
  it("writes an activity file the Garmin SDK decodes: timer events at the pauses, records, laps, session and activity", () => {
    const computation = computed("venu3s-run.fit");
    const processed = computation.processed;
    if (processed === null) throw new Error("No processed track");
    const messages = decodedFit(exportFit(inputOf(computation, { energyKcal: 420 })));
    expect(messages.fileIdMesgs?.[0]).toMatchObject({ type: "activity", manufacturer: "development", productName: "Obnixe" });
    expect(messages.eventMesgs?.map((event) => `${String(event.event)}:${String(event.eventType)}`)).toEqual(["timer:start", "timer:stopAll", "timer:start", "timer:stopAll"]);
    const records = messages.recordMesgs ?? [];
    expect(records).toHaveLength(processed.series.length);
    for (const record of records) expect(record).toMatchObject({ positionLat: expect.any(Number), positionLong: expect.any(Number), enhancedAltitude: expect.any(Number), distance: expect.any(Number), enhancedSpeed: expect.any(Number), heartRate: expect.any(Number) });
    const distances = records.map((record) => Number(record.distance));
    expect(distances).toEqual([...distances].sort((left, right) => left - right));
    expect(distances.at(-1)).toBeCloseTo(processed.summary.distanceMm / 1000, 1);
    const session = messages.sessionMesgs?.[0];
    expect(session).toMatchObject({ sport: "running", subSport: "street", totalCalories: 420, numLaps: processed.laps.length, totalElapsedTime: (processed.elapsed.endMs - processed.elapsed.startMs) / 1000 });
    expect(Number(session?.totalDistance)).toBeCloseTo(processed.summary.distanceMm / 1000, 1);
    expect(Number(session?.totalTimerTime)).toBeLessThan(Number(session?.totalElapsedTime));
    const laps = messages.lapMesgs ?? [];
    expect(laps).toHaveLength(processed.laps.length);
    expect(Math.abs(laps.reduce((total, lap) => total + Number(lap.totalCalories), 0) - 420)).toBeLessThanOrEqual(laps.length);
    expect(messages.activityMesgs?.[0]).toMatchObject({ numSessions: 1, type: "manual" });
  });

  it("marks the laps of a guided workout as manual in FIT and TCX", () => {
    const computation = computed("venu3s-run.fit");
    const processed = computation.processed;
    if (processed === null) throw new Error("No processed track");
    const triggers = ["workout", "distance", "duration"] as const;
    const guided = { ...processed, laps: processed.laps.map((lap, index) => ({ ...lap, bounds: { ...lap.bounds, trigger: triggers[index % triggers.length] ?? "workout" } })) };
    const expected = guided.laps.map((lap) => lap.bounds.trigger);
    const fitLaps = decodedFit(exportFit(inputOf(computation, { processed: guided }))).lapMesgs ?? [];
    expect(fitLaps.map((lap) => lap.lapTrigger)).toEqual(expected.map((trigger) => ({ workout: "manual", distance: "distance", duration: "time" })[trigger]));
    const tcx = exportTcx(inputOf(computation, { processed: guided }));
    expect([...tcx.matchAll(/<TriggerMethod>(\w+)<\/TriggerMethod>/g)].map((match) => match[1])).toEqual(expected.map((trigger) => ({ workout: "Manual", distance: "Distance", duration: "Time" })[trigger]));
  });

  it("reads back the same points, pauses, laps and sport", () => {
    const computation = computed("venu3s-run.fit");
    const back = reread(computation, "fit");
    expect(back.format).toBe("fit");
    expect(back.device).toBe("Obnixe");
    expect(back.sport).toEqual({ sport: "run", values: {} });
    expect(back.startedAt).toBe(computation.activity.startedAt);
    expect(back.marks).toEqual(computation.activity.marks);
    expect(back.laps).toEqual(computation.activity.laps);
    expect(back.points.length).toBe(computation.processed?.series.length);
    for (const point of back.points) {
      const source = computation.activity.points.find((candidate) => candidate.t === point.t);
      expect(source).toBeDefined();
      expect(Math.abs((point.latitudeE7 ?? 0) - (source?.latitudeE7 ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs((point.longitudeE7 ?? 0) - (source?.longitudeE7 ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs((point.altitudeMm ?? 0) - (source?.altitudeMm ?? 0))).toBeLessThanOrEqual(100);
      expect(point.heartRate).toBe(source?.heartRate);
      expect(point.horizontalAccuracyDm).toBe(50);
    }
  });

  it("exports every fix of a sport without a profile, with its pauses and the swim sub sport", () => {
    const activity = activityOf("multi-track.gpx");
    const swim = computeImport(activity, { sport: "swim", values: { water: "open_water" } });
    const back = readFit(exportFit(inputOf(swim)));
    expect(back.points).toHaveLength(activity.points.length);
    expect(back.marks.map((mark) => mark.kind)).toEqual(["start", "pause", "resume", "stop"]);
    expect(back.sport).toEqual({ sport: "swim", values: { water: "open_water" } });
  });

  it.each(scenarioNames)("gives back the distance, moving time and ascent of %s when imported again", (name) => {
    const difference = reimportDifference(name, "fit");
    expect(difference.distanceRatio).toBeLessThanOrEqual(0.001);
    expect(difference.movingMs).toBeLessThanOrEqual(1000);
    expect(difference.ascentMm).toBeLessThanOrEqual(1000);
  });
});

describe("FIT sport and sub sport (annex D)", () => {
  const cases: readonly { readonly guess: SportGuess; readonly fit: FitSportPair; readonly back: SportGuess | null }[] = [
    { guess: { sport: "run", values: {} }, fit: { sport: fitSport.running, subSport: fitSubSport.street }, back: { sport: "run", values: {} } },
    { guess: { sport: "trail", values: {} }, fit: { sport: fitSport.running, subSport: fitSubSport.trail }, back: { sport: "trail", values: {} } },
    { guess: { sport: "walk", values: {} }, fit: { sport: fitSport.walking, subSport: fitSubSport.generic }, back: { sport: "walk", values: {} } },
    { guess: { sport: "hike", values: { kind: "snow" } }, fit: { sport: fitSport.hiking, subSport: fitSubSport.generic }, back: { sport: "hike", values: {} } },
    { guess: { sport: "bike", values: { kind: "road" } }, fit: { sport: fitSport.cycling, subSport: fitSubSport.road }, back: { sport: "bike", values: { kind: "road" } } },
    { guess: { sport: "bike", values: { kind: "gravel" } }, fit: { sport: fitSport.cycling, subSport: fitSubSport.gravelCycling }, back: { sport: "bike", values: { kind: "gravel" } } },
    { guess: { sport: "bike", values: { kind: "mtb" } }, fit: { sport: fitSport.cycling, subSport: fitSubSport.mountain }, back: { sport: "bike", values: { kind: "mtb" } } },
    { guess: { sport: "bike", values: { kind: "commute" } }, fit: { sport: fitSport.cycling, subSport: fitSubSport.commuting }, back: { sport: "bike", values: { kind: "commute" } } },
    { guess: { sport: "bike", values: { kind: "indoor" } }, fit: { sport: fitSport.cycling, subSport: fitSubSport.virtualActivity }, back: { sport: "bike", values: { kind: "indoor" } } },
    { guess: { sport: "bike", values: { kind: "road", e_bike: true } }, fit: { sport: fitSport.eBiking, subSport: fitSubSport.generic }, back: { sport: "bike", values: { kind: "road", e_bike: true } } },
    { guess: { sport: "bike", values: { kind: "mtb", e_bike: true } }, fit: { sport: fitSport.eBiking, subSport: fitSubSport.eBikeMountain }, back: { sport: "bike", values: { kind: "mtb", e_bike: true } } },
    { guess: { sport: "swim", values: { water: "pool" } }, fit: { sport: fitSport.swimming, subSport: fitSubSport.lapSwimming }, back: { sport: "swim", values: { water: "pool" } } },
    { guess: { sport: "swim", values: { water: "open_water" } }, fit: { sport: fitSport.swimming, subSport: fitSubSport.openWater }, back: { sport: "swim", values: { water: "open_water" } } },
    { guess: { sport: "ski_touring", values: { kind: "splitboard" } }, fit: { sport: fitSport.alpineSkiing, subSport: fitSubSport.backcountry }, back: { sport: "ski_touring", values: { kind: "touring" } } },
    { guess: { sport: "nordic_ski", values: { kind: "skate" } }, fit: { sport: fitSport.crossCountrySkiing, subSport: fitSubSport.skateSkiing }, back: { sport: "nordic_ski", values: { kind: "skate" } } },
    { guess: { sport: "nordic_ski", values: { kind: "classic" } }, fit: { sport: fitSport.crossCountrySkiing, subSport: fitSubSport.generic }, back: { sport: "nordic_ski", values: { kind: "classic" } } },
    { guess: { sport: "alpine_ski", values: { kind: "ski" } }, fit: { sport: fitSport.alpineSkiing, subSport: fitSubSport.generic }, back: { sport: "alpine_ski", values: { kind: "ski" } } },
    { guess: { sport: "alpine_ski", values: { kind: "snowboard" } }, fit: { sport: fitSport.snowboarding, subSport: fitSubSport.generic }, back: { sport: "alpine_ski", values: { kind: "snowboard" } } },
    { guess: { sport: "paddle", values: { kind: "kayak" } }, fit: { sport: fitSport.kayaking, subSport: fitSubSport.generic }, back: { sport: "paddle", values: { kind: "kayak" } } },
    { guess: { sport: "paddle", values: { kind: "canoe" } }, fit: { sport: fitSport.paddling, subSport: fitSubSport.generic }, back: { sport: "paddle", values: { kind: "canoe" } } },
    { guess: { sport: "paddle", values: { kind: "sup" } }, fit: { sport: fitSport.standUpPaddleboarding, subSport: fitSubSport.generic }, back: { sport: "paddle", values: { kind: "sup" } } },
    { guess: { sport: "paddle", values: { kind: "rowing" } }, fit: { sport: fitSport.rowing, subSport: fitSubSport.generic }, back: { sport: "paddle", values: { kind: "rowing" } } },
    { guess: { sport: "inline_skate", values: { kind: "speed" } }, fit: { sport: fitSport.inlineSkating, subSport: fitSubSport.generic }, back: { sport: "inline_skate", values: {} } },
    { guess: { sport: "strength", values: {} }, fit: { sport: fitSport.generic, subSport: fitSubSport.generic }, back: null },
  ];

  it("follows the FIT column and reads back as the same sport", () => {
    for (const { guess, fit, back } of cases) {
      expect(fitSportOf(guess.sport, guess.values)).toEqual(fit);
      expect(sportOfFit(fit.sport, fit.subSport, true)).toEqual(back);
    }
  });
});

describe("TCX export (IO-003)", () => {
  it("writes one lap per lap with its totals and one track per continuous part", () => {
    const computation = computed("venu3s-run.fit");
    const processed = computation.processed;
    if (processed === null) throw new Error("No processed track");
    const tcx = exportTcx(inputOf(computation, { energyKcal: 420 }));
    expect(tcx).toContain('xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"');
    expect(tcx).toContain('<Activity Sport="Running">');
    expect(tcx.match(/<Lap StartTime=/g)).toHaveLength(processed.laps.length);
    expect(tcx).toMatch(/<Trackpoint><Time>2026-11-20T\d\d:\d\d:\d\d\.\d{3}Z<\/Time><Position><LatitudeDegrees>45\.\d{7}<\/LatitudeDegrees><LongitudeDegrees>6\.\d{7}<\/LongitudeDegrees><\/Position><AltitudeMeters>\d+\.\d<\/AltitudeMeters><DistanceMeters>\d+\.\d\d<\/DistanceMeters><HeartRateBpm><Value>\d+<\/Value><\/HeartRateBpm>/);
    const back = readTcx(encoder.encode(tcx));
    expect(back.sport).toEqual({ sport: "run", values: {} });
    expect(back.startedAt).toBe(computation.activity.startedAt);
    expect(back.marks.map((mark) => mark.kind)).toEqual(["start", "pause", "resume", "stop"]);
    expect(back.laps.map((lap) => lap.startMs)).toEqual(computation.activity.laps.map((lap) => lap.startMs));
    expect(Math.abs((back.totals?.energyKcal ?? 0) - 420)).toBeLessThanOrEqual(processed.laps.length);
    expect(back.totals?.distanceMm).toBeCloseTo(processed.summary.distanceMm, -1);
    expect(back.points.length).toBe(processed.series.length);
    for (const point of back.points) {
      const source = computation.activity.points.find((candidate) => candidate.t === point.t);
      expect(point.latitudeE7).toBe(source?.latitudeE7);
      expect(point.longitudeE7).toBe(source?.longitudeE7);
      expect(point.heartRate).toBe(source?.heartRate);
    }
  });

  it("maps walks, hikes, swims and the snow, water and skating sports to Other", () => {
    const sports: readonly SportKey[] = ["run", "trail", "bike", "walk", "hike", "swim", "ski_touring", "nordic_ski", "alpine_ski", "paddle", "inline_skate"];
    expect(sports.map(tcxSportOf)).toEqual(["Running", "Running", "Biking", "Other", "Other", "Other", "Other", "Other", "Other", "Other", "Other"]);
  });

  it.each(scenarioNames)("gives back the distance, moving time and ascent of %s when imported again", (name) => {
    const difference = reimportDifference(name, "tcx");
    expect(difference.distanceRatio).toBeLessThanOrEqual(0.001);
    expect(difference.movingMs).toBeLessThanOrEqual(1000);
    expect(difference.ascentMm).toBeLessThanOrEqual(1000);
  });
});

describe("export privacy (PRV-010, PRV-011)", () => {
  function zoneAtStart(computation: ImportComputation, radiusMeters: number): Id {
    const start = computation.activity.points[0];
    const plan = newPrivacyZone(context.env, { label: "Maison", center: { latitude: (start?.latitudeE7 ?? 0) / 1e7, longitude: (start?.longitudeE7 ?? 0) / 1e7 }, radiusMeters }, 1000);
    make.write([plan.mutation]);
    return plan.zoneId;
  }

  it("leaves out the points of the active zones and the track ends, unless the full track is included", () => {
    const computation = computed("garmin-connect-run.gpx");
    zoneAtStart(computation, 150);
    const mask = exportPrivacyMask(context.db);
    expect(mask?.zones).toHaveLength(1);
    const back = readGpx(encoder.encode(exportOf(computation, { mask })));
    const start = computation.activity.points[0];
    for (const point of back.points) {
      expect(ellipsoidDistance((start?.latitudeE7 ?? 0) / 1e7, (start?.longitudeE7 ?? 0) / 1e7, (point.latitudeE7 ?? 0) / 1e7, (point.longitudeE7 ?? 0) / 1e7)).toBeGreaterThan(150);
    }
    expect(back.points.length).toBeLessThan(computation.activity.points.length);
    expect(exportPrivacyMask(context.db, true)).toBeNull();
    updateSettings(context.db, { hideTrackEndsMeters: 300 }, context.env.now());
    expect(exportPrivacyMask(context.db)?.hideEndsMeters).toBe(300);
    const shorter = readGpx(encoder.encode(exportOf(computation, { mask: exportPrivacyMask(context.db) })));
    expect(shorter.points.length).toBeLessThan(back.points.length);
  });

  it.each(["fit", "tcx"] as const)("leaves out the same points from the %s export", (format) => {
    const computation = computed("garmin-connect-run.gpx");
    zoneAtStart(computation, 150);
    updateSettings(context.db, { hideTrackEndsMeters: 300 }, context.env.now());
    const mask = exportPrivacyMask(context.db);
    const gpx = readGpx(encoder.encode(exportOf(computation, { mask })));
    const back = reread(computation, format, { mask });
    expect(back.points.length).toBeGreaterThan(0);
    expect(absoluteTimes(back)).toEqual(absoluteTimes(gpx));
    expect(reread(computation, format).points).toHaveLength(computation.activity.points.length);
  });

  it("ignores trashed zones and includes the full track by default when export privacy is off", () => {
    const computation = computed("garmin-connect-run.gpx");
    const zoneId = zoneAtStart(computation, 150);
    expect(exportPrivacyMask(context.db)?.zones).toHaveLength(1);
    make.write([trashMutation("privacy_zone", zoneId, context.env.now())]);
    expect(exportPrivacyMask(context.db)).toEqual({ zones: [], hideEndsMeters: 0 });
    updateSettings(context.db, { exportPrivacy: false }, context.env.now());
    expect(exportPrivacyMask(context.db)).toBeNull();
    expect(exportPrivacyMask(context.db, false)).toEqual({ zones: [], hideEndsMeters: 0 });
  });
});

describe("export file name (IO-004)", () => {
  it("uses the local start date and the normalized title, or the sport name", () => {
    const startedAt = Date.UTC(2026, 10, 20, 23, 30) as EpochMs;
    expect(exportFileName({ startedAt, timeZone: "Europe/Paris", title: "Sortie à l'Étoile – côte !", sport: "run" }, "gpx")).toBe("obnixe-2026-11-21-sortie-a-l-etoile-cote.gpx");
    expect(exportFileName({ startedAt, timeZone: "UTC", title: null, sport: "bike" }, "gpx")).toBe("obnixe-2026-11-20-velo.gpx");
    expect(exportFileName({ startedAt, timeZone: "UTC", title: "   ", sport: "run" }, "gpx")).toBe("obnixe-2026-11-20-course.gpx");
    expect(exportFileName({ startedAt, timeZone: "UTC", title: null, sport: "trail" }, "fit")).toBe("obnixe-2026-11-20-trail.fit");
    expect(exportFileName({ startedAt, timeZone: "UTC", title: null, sport: "hike" }, "tcx")).toBe("obnixe-2026-11-20-rando.tcx");
  });
});
