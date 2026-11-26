import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { EpochMs, Id } from "@obnixe/schema";
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
import { exportFileName, exportGpx } from "./export.ts";
import type { GpxExportInput } from "./export.ts";
import { readGpx } from "./gpx.ts";
import { computeImport } from "./import.ts";
import type { ImportComputation } from "./import.ts";
import { readActivityFile } from "./zip.ts";

const fixtureDirectory = new URL("../../../test/fixtures/import/", import.meta.url);
const activityOf = (name: string): ImportedActivity => readActivityFile(new Uint8Array(readFileSync(new URL(name, fixtureDirectory))));
const encoder = new TextEncoder();

function computed(name: string): ImportComputation {
  const activity = activityOf(name);
  if (activity.sport === null) throw new Error(`${name} has no sport`);
  return computeImport(activity, activity.sport);
}

function exportOf(computation: ImportComputation, overrides: Partial<GpxExportInput> = {}): string {
  return exportGpx({ track: computation.track, processed: computation.processed, trim: untrimmed, sport: computation.sport.sport, title: null, mask: null, ...overrides });
}

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
    const swim = computeImport(activity, { sport: "swim", values: { water: "open_water" } });
    expect(swim.processed).toBeNull();
    const back = readGpx(encoder.encode(exportOf(swim)));
    expect(back.points).toHaveLength(activity.points.length);
    expect(back.marks.map((mark) => mark.kind)).toEqual(["start", "pause", "resume", "stop"]);
    expect(back.points[0]?.speedMmS).toBe(activity.points[0]?.speedMmS);
  });

  it("applies the trim", () => {
    const computation = computed("garmin-connect-run.gpx");
    const gpx = exportGpx({ track: computation.track, processed: null, trim: { startMs: 60_000, endMs: 120_000 }, sport: "run", title: null, mask: null });
    const back = readGpx(encoder.encode(gpx));
    expect(back.startedAt).toBe(computation.activity.startedAt + 60_000);
    expect(back.points.at(-1)?.t).toBe(60_000);
  });

  it.each(["steadyRun", "stopAndGo", "tunnel90s", "forestCanopy", "sawtooth", "steepClimb"] as const)("gives back the distance, moving time and ascent of %s when imported again", (name) => {
    const scenario = name === "sawtooth" || name === "steepClimb" ? stageScenarios[name](3) : coreScenarios[name](3);
    const processed = runBatch(scenario);
    const gpx = exportGpx({ track: trackOf(scenario.samples), processed, trim: untrimmed, sport: scenario.sport, title: null, mask: null });
    const reimported = computeImport(readGpx(encoder.encode(gpx)), { sport: scenario.sport, values: {} }).summary;
    const { summary } = processed;
    expect(Math.abs(reimported.distanceMm - summary.distanceMm)).toBeLessThanOrEqual(summary.distanceMm / 1000);
    expect(Math.abs(reimported.movingMs - summary.movingMs)).toBeLessThanOrEqual(1000);
    expect(Math.abs((reimported.ascentMm ?? 0) - (summary.ascentMm ?? 0))).toBeLessThanOrEqual(1000);
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
  });
});
