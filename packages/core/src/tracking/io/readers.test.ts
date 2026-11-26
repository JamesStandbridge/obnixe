import { readFileSync } from "node:fs";
import { Decoder, Stream } from "@garmin/fitsdk";
import { gzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ImportError } from "./errors.ts";
import type { ImportErrorReason } from "./errors.ts";
import { fitCrc, readFit, readFitCourse } from "./fit.ts";
import { readGpx, readGpxRoute } from "./gpx.ts";
import { fitSport, fitSubSport, sportOfFit, sportOfGpxType, sportOfTcx } from "./sports.ts";
import { readTcx, readTcxCourse } from "./tcx.ts";
import { readActivityFile, readRouteFile } from "./zip.ts";

const fixtures = new URL("../../../test/fixtures/import/", import.meta.url);
const read = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, fixtures)));
const fitEpochMs = 631_065_600_000;

function failure(run: () => unknown): ImportErrorReason | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof ImportError) return error.reason;
    throw error;
  }
}

describe("GPX reader (IO-013)", () => {
  it("reads a Garmin Connect export with TrackPointExtension v1", () => {
    const activity = readGpx(read("garmin-connect-run.gpx"));
    expect(activity.format).toBe("gpx");
    expect(activity.name).toBe("Annecy Course à pied");
    expect(activity.sport).toEqual({ sport: "run", values: {} });
    expect(activity.startedAt).toBe(Date.UTC(2026, 10, 2, 7, 31, 5));
    expect(activity.externalId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(activity.points).toHaveLength(120);
    expect(activity.points[0]).toMatchObject({ t: 0, latitudeE7: 458_992_130, longitudeE7: 61_294_180, heartRate: expect.any(Number), cadence: expect.any(Number) });
    expect(activity.points[1]?.t).toBe(2000);
    expect(activity.marks).toEqual([
      { kind: "start", t: 0 },
      { kind: "stop", t: 238_000 },
    ]);
  });

  it("reads Strava extensions among unknown ones and a CDATA name from Komoot", () => {
    const ride = readGpx(read("strava-ride.gpx"));
    expect(ride.name).toBe("Sortie vélo du matin");
    expect(ride.sport).toEqual({ sport: "bike", values: { kind: "road" } });
    expect(ride.points.every((point) => point.heartRate !== null && point.cadence !== null)).toBe(true);
    const hike = readGpx(read("komoot-hike.gpx"));
    expect(hike.name).toBe("Col de la Forclaz – Montmin");
    expect(hike.sport).toBeNull();
    expect(hike.points[0]?.heartRate).toBeNull();
  });

  it("makes every new track or segment a pause, GPX 1.0 speed and course included", () => {
    const activity = readGpx(read("multi-track.gpx"));
    expect(activity.sport?.sport).toBe("walk");
    expect(activity.marks.map((mark) => mark.kind)).toEqual(["start", "pause", "resume", "stop"]);
    expect(activity.marks[2]!.t - activity.marks[1]!.t).toBe(600_000);
    expect(activity.points[0]?.altitudeMm).toBeNull();
    expect(activity.points[0]?.speedMmS).toBeGreaterThan(0);
    expect(activity.points[0]?.courseCentiDeg).toBeGreaterThanOrEqual(9000);
  });

  it("refuses a route without times", () => {
    expect(failure(() => readGpx(read("komoot-route.gpx")))).toBe("untimed");
  });
});

describe("TCX reader", () => {
  it("reads laps, lap totals, RunCadence and Speed", () => {
    const activity = readTcx(read("garmin-run.tcx"));
    expect(activity.device).toBe("Forerunner 965");
    expect(activity.sport).toEqual({ sport: "run", values: {} });
    expect(activity.points).toHaveLength(80);
    expect(activity.laps).toEqual([
      { startMs: 0, endMs: 80_000 },
      { startMs: 80_000, endMs: 158_000 },
    ]);
    expect(activity.totals).toMatchObject({ elapsedMs: null, timerMs: 160_000, energyKcal: 66, heartRateMax: 164 });
    expect(activity.totals?.heartRateAvg).toBeGreaterThan(140);
    expect(activity.points[0]?.cadence).toBeGreaterThan(80);
    expect(activity.points[0]?.speedMmS).toBeGreaterThan(3000);
  });
});

describe("FIT reader (IO-050)", () => {
  it("matches the Garmin SDK on a Venu 3S run with a pause, laps and a developer field", () => {
    const bytes = read("venu3s-run.fit");
    const activity = readFit(bytes);
    const { messages, errors } = new Decoder(Stream.fromByteArray(Array.from(bytes))).read({ convertDateTimesToDates: false });
    expect(errors).toEqual([]);
    const records = messages.recordMesgs ?? [];
    expect(activity.points).toHaveLength(records.length);
    const startedAt = activity.startedAt;
    records.forEach((record, index) => {
      const point = activity.points[index];
      expect(point?.t).toBe(Number(record.timestamp) * 1000 + fitEpochMs - startedAt);
      expect(point?.latitudeE7).toBe(Math.round(((Number(record.positionLat) * 180) / 2 ** 31) * 1e7));
      expect(point?.longitudeE7).toBe(Math.round(((Number(record.positionLong) * 180) / 2 ** 31) * 1e7));
      expect(point?.heartRate).toBe(record.heartRate);
      expect(point?.altitudeMm).toBeCloseTo(Number(record.enhancedAltitude) * 1000, -1);
      expect(point?.cadence).toBe(Number(record.cadence) + Number(record.fractionalCadence));
    });
    const session = messages.sessionMesgs?.[0];
    expect(activity.totals).toEqual({
      elapsedMs: Math.round(Number(session?.totalElapsedTime) * 1000),
      timerMs: Math.round(Number(session?.totalTimerTime) * 1000),
      distanceMm: Math.round(Number(session?.totalDistance) * 1000),
      energyKcal: session?.totalCalories,
      heartRateAvg: session?.avgHeartRate,
      heartRateMax: session?.maxHeartRate,
    });
    expect(activity.device).toBe("Garmin Venu 3S");
    expect(activity.externalId).toBe(`fit:1:4261:3456789012:${String(messages.fileIdMesgs?.[0]?.timeCreated)}`);
    expect(activity.sport).toEqual({ sport: "run", values: {} });
    expect(activity.marks).toEqual([
      { kind: "start", t: 0 },
      { kind: "pause", t: 259_000 },
      { kind: "resume", t: 334_000 },
      { kind: "stop", t: 618_000 },
    ]);
    expect(activity.laps).toEqual([
      { startMs: 0, endMs: 451_000 },
      { startMs: 451_000, endMs: 618_000 },
    ]);
  });

  it("turns a pool swim into lengths, pool length and distance", () => {
    const activity = readFit(read("venu3s-pool-swim.fit"));
    expect(activity.sport).toEqual({ sport: "swim", values: { water: "pool" } });
    expect(activity.pool).toEqual({ poolLengthMeters: 25, lengths: 40, distanceMeters: 1000 });
    expect(activity.points.every((point) => point.latitudeE7 === null)).toBe(true);
    expect(activity.laps).toHaveLength(4);
  });

  it("reads a treadmill run without positions", () => {
    const activity = readFit(read("venu3s-treadmill.fit"));
    expect(activity.sport?.sport).toBe("run");
    expect(activity.pool).toBeNull();
    expect(activity.totals?.distanceMm).toBe(1_750_000);
    expect(activity.points.every((point) => point.latitudeE7 === null && point.heartRate !== null)).toBe(true);
  });

  it("decodes big-endian definitions, compressed timestamps with rollover and chained files", () => {
    const start = 1_100_000_030;
    const handmade = fitFile([
      [0x40, 0, 1, 0, 0, 2, 0, 1, 0x00, 4, 4, 0x86],
      [0x00, 4, ...uint32BigEndian(start)],
      [0x41, 0, 1, 0, 20, 4, 253, 4, 0x86, 0, 4, 0x85, 1, 4, 0x85, 3, 1, 0x02],
      [0x01, ...uint32BigEndian(start), ...int32BigEndian(547_608_328), ...int32BigEndian(73_076_400), 120],
      [0x42, 0, 1, 0, 20, 3, 0, 4, 0x85, 1, 4, 0x85, 3, 1, 0x02],
      [0x80 | (2 << 5) | ((start + 1) & 0x1f), ...int32BigEndian(547_608_428), ...int32BigEndian(73_076_500), 121],
      [0x80 | (2 << 5) | ((start + 3) & 0x1f), ...int32BigEndian(547_608_528), ...int32BigEndian(73_076_600), 122],
    ]);
    const chained = new Uint8Array([...handmade, ...fitFile([[0x40, 0, 0, 0, 0, 1, 0, 1, 0x00], [0x00, 4]])]);
    const activity = readFit(chained);
    expect(activity.startedAt).toBe(start * 1000 + fitEpochMs);
    expect(activity.points.map((point) => point.t)).toEqual([0, 1000, 3000]);
    expect(activity.points.map((point) => point.heartRate)).toEqual([120, 121, 122]);
    expect(activity.points[0]?.latitudeE7).toBe(Math.round(((547_608_328 * 180) / 2 ** 31) * 1e7));
  });
});

function uint32BigEndian(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

const int32BigEndian = (value: number): number[] => uint32BigEndian(value >>> 0);

/** A FIT file with a 12-byte header, the given records and its CRC. */
function fitFile(records: readonly (readonly number[])[]): Uint8Array {
  const data = records.flat();
  const bytes = new Uint8Array(12 + data.length + 2);
  const view = new DataView(bytes.buffer);
  bytes.set([12, 0x10, 0xae, 0x08], 0);
  view.setUint32(4, data.length, true);
  bytes.set([0x2e, 0x46, 0x49, 0x54], 8);
  bytes.set(data, 12);
  view.setUint16(12 + data.length, fitCrc(bytes, 0, 12 + data.length), true);
  return bytes;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function int32LittleEndian(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

describe("route readers (RTE-001)", () => {
  it("reads an untimed GPX track with its altitudes and its name", () => {
    const route = readGpxRoute(read("komoot-route.gpx"));
    expect(route.format).toBe("gpx");
    expect(route.name).toBe("Planned tour");
    expect(route.points).toHaveLength(20);
    expect(route.points[0]).toEqual({ latitudeE7: 458_023_100, longitudeE7: 62_319_500, altitudeMm: 447_000 });
  });

  it("reads a recorded GPX activity as a route too", () => {
    const route = readGpxRoute(read("garmin-connect-run.gpx"));
    expect(route.points).toHaveLength(120);
    expect(route.sport).toEqual({ sport: "run", values: {} });
  });

  it("reads the waypoints of a GPX rte with its type, and refuses a GPX with neither", () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><rte><name>Boucle</name><type>cycling</type>
      <rtept lat="45.9" lon="6.1"><ele>450</ele><name>Départ</name></rtept><rtept lat="45.91" lon="6.11"/><rtept lat="45.92" lon="6.1"><ele>480.5</ele></rtept></rte></gpx>`;
    const route = readGpxRoute(encode(gpx));
    expect(route.name).toBe("Boucle");
    expect(route.sport).toEqual({ sport: "bike", values: { kind: "road" } });
    expect(route.points).toEqual([
      { latitudeE7: 459_000_000, longitudeE7: 61_000_000, altitudeMm: 450_000 },
      { latitudeE7: 459_100_000, longitudeE7: 61_100_000, altitudeMm: null },
      { latitudeE7: 459_200_000, longitudeE7: 61_000_000, altitudeMm: 480_500 },
    ]);
    expect(failure(() => readGpxRoute(read("malformed/no-track.gpx")))).toBe("not_a_route");
  });

  it("reads the first TCX course and refuses a TCX activity", () => {
    const tcx = `<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Courses><Course><Name>Semnoz</Name>
      <Lap><TotalTimeSeconds>0</TotalTimeSeconds></Lap><Track>
      <Trackpoint><Time>2026-01-01T00:00:00Z</Time><Position><LatitudeDegrees>45.8</LatitudeDegrees><LongitudeDegrees>6.1</LongitudeDegrees></Position><AltitudeMeters>500</AltitudeMeters></Trackpoint>
      <Trackpoint><Time>2026-01-01T00:00:10Z</Time></Trackpoint>
      <Trackpoint><Position><LatitudeDegrees>45.81</LatitudeDegrees><LongitudeDegrees>6.11</LongitudeDegrees></Position></Trackpoint>
      </Track><CoursePoint><Name>Col</Name><Position><LatitudeDegrees>45.0</LatitudeDegrees><LongitudeDegrees>6.0</LongitudeDegrees></Position></CoursePoint></Course>
      <Course><Name>Autre</Name></Course></Courses></TrainingCenterDatabase>`;
    const route = readTcxCourse(encode(tcx));
    expect(route).toEqual({
      format: "tcx",
      name: "Semnoz",
      sport: null,
      points: [
        { latitudeE7: 458_000_000, longitudeE7: 61_000_000, altitudeMm: 500_000 },
        { latitudeE7: 458_100_000, longitudeE7: 61_100_000, altitudeMm: null },
      ],
    });
    expect(failure(() => readTcxCourse(read("garmin-run.tcx")))).toBe("not_a_route");
  });

  it("reads a FIT course with its name and sport, and refuses a FIT activity", () => {
    const name = [...encode("Tour du lac")];
    const course = fitFile([
      [0x40, 0, 0, 0, 0, 1, 0, 1, 0x00],
      [0x00, 6],
      [0x41, 0, 0, 31, 0, 2, 4, 1, 0x00, 5, 16, 0x07],
      [0x01, fitSport.cycling, ...name, ...Array<number>(16 - name.length).fill(0)],
      [0x42, 0, 0, 20, 0, 3, 0, 4, 0x85, 1, 4, 0x85, 2, 2, 0x84],
      [0x02, ...int32LittleEndian(547_608_328), ...int32LittleEndian(73_076_400), 0xc4, 0x09],
      [0x02, ...int32LittleEndian(547_609_328), ...int32LittleEndian(73_077_400), 0xff, 0xff],
    ]);
    const route = readFitCourse(course);
    expect(route.name).toBe("Tour du lac");
    expect(route.sport).toEqual({ sport: "bike", values: { kind: "road" } });
    expect(route.points).toHaveLength(2);
    expect(route.points[0]?.altitudeMm).toBe(0x09c4 * 200 - 500_000);
    expect(route.points[1]?.altitudeMm).toBeNull();
    expect(readFitCourse(read("malformed/course.fit")).points).toHaveLength(10);
    expect(failure(() => readFitCourse(read("venu3s-run.fit")))).toBe("not_a_route");
  });

  it("finds the route in any container, and refuses a route of a single point", () => {
    expect(readRouteFile(gzipSync(read("komoot-route.gpx"))).points).toHaveLength(20);
    expect(readRouteFile(read("malformed/course.fit")).format).toBe("fit");
    const single = `<gpx version="1.1"><trk><trkseg><trkpt lat="45.9" lon="6.1"/></trkseg></trk></gpx>`;
    expect(failure(() => readRouteFile(encode(single)))).toBe("not_a_route");
    expect(failure(() => readRouteFile(read("malformed/not-an-activity.txt")))).toBe("unsupported_format");
  });
});

describe("file detection and archives", () => {
  it("reads the same activity from a .fit, a .fit.gz and a Garmin Connect Export original ZIP", () => {
    const direct = readActivityFile(read("venu3s-run.fit"));
    expect(readActivityFile(read("venu3s-run.fit.gz"))).toEqual(direct);
    expect(readActivityFile(read("garmin-export-original.zip"))).toEqual(direct);
    expect(readActivityFile(read("garmin-run.tcx")).format).toBe("tcx");
    expect(readActivityFile(read("komoot-hike.gpx")).format).toBe("gpx");
  });
});

describe("robustness corpus (IO-013)", () => {
  const corpus: Readonly<Record<string, ImportErrorReason>> = {
    "malformed/truncated.gpx": "truncated",
    "malformed/unordered-times.gpx": "unordered_time",
    "malformed/out-of-bounds.gpx": "invalid_coordinates",
    "malformed/bare-ampersand.gpx": "malformed",
    "malformed/no-track.gpx": "no_activity_data",
    "malformed/bad-crc.fit": "checksum",
    "malformed/truncated.fit": "truncated",
    "malformed/course.fit": "not_an_activity",
    "malformed/two-activities.zip": "several_activities",
    "malformed/photos.zip": "no_activity_data",
    "malformed/two-activities.tcx": "several_activities",
    "malformed/unclosed.tcx": "malformed",
    "malformed/not-an-activity.txt": "unsupported_format",
    "komoot-route.gpx": "untimed",
  };

  it.each(Object.entries(corpus))("refuses %s with a typed error", (name, reason) => {
    expect(failure(() => readActivityFile(read(name)))).toBe(reason);
  });

  it("refuses every truncation of a FIT file and of a GPX file, never importing part of it", () => {
    const fit = read("venu3s-run.fit");
    const gpx = read("garmin-connect-run.gpx");
    for (let length = 0; length < fit.length; length += 97) expect(failure(() => readActivityFile(fit.subarray(0, length)))).not.toBeNull();
    for (let length = 600; length < gpx.length - 20; length += 997) expect(failure(() => readActivityFile(gpx.subarray(0, length)))).not.toBeNull();
  });

  it("refuses invalid UTF-8, a bad deflate stream and a gzip inside a gzip", () => {
    expect(failure(() => readActivityFile(new Uint8Array([0x3c, 0x67, 0x70, 0x78, 0x3e, 0xff, 0x3c, 0x2f, 0x67, 0x70, 0x78, 0x3e])))).toBe("malformed");
    expect(failure(() => readActivityFile(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xff, 0xff])))).toBe("malformed");
    expect(failure(() => readActivityFile(gzipSync(gzipSync(read("komoot-hike.gpx")))))).toBe("unsupported_format");
  });
});

describe("annex D sport mapping", () => {
  it.each([
    [fitSport.running, fitSubSport.generic, true, { sport: "run", values: {} }],
    [fitSport.running, fitSubSport.trail, true, { sport: "trail", values: {} }],
    [fitSport.running, fitSubSport.treadmill, false, { sport: "run", values: {} }],
    [fitSport.walking, fitSubSport.generic, true, { sport: "walk", values: {} }],
    [fitSport.hiking, fitSubSport.generic, true, { sport: "hike", values: {} }],
    [fitSport.snowshoeing, fitSubSport.generic, true, { sport: "hike", values: { kind: "snow" } }],
    [fitSport.cycling, fitSubSport.road, true, { sport: "bike", values: { kind: "road" } }],
    [fitSport.cycling, fitSubSport.gravelCycling, true, { sport: "bike", values: { kind: "gravel" } }],
    [fitSport.cycling, fitSubSport.mountain, true, { sport: "bike", values: { kind: "mtb" } }],
    [fitSport.cycling, fitSubSport.virtualActivity, false, { sport: "bike", values: { kind: "indoor" } }],
    [fitSport.eBiking, fitSubSport.generic, true, { sport: "bike", values: { kind: "road", e_bike: true } }],
    [fitSport.eBiking, fitSubSport.eBikeMountain, true, { sport: "bike", values: { kind: "mtb", e_bike: true } }],
    [fitSport.swimming, fitSubSport.openWater, true, { sport: "swim", values: { water: "open_water" } }],
    [fitSport.swimming, fitSubSport.lapSwimming, false, { sport: "swim", values: { water: "pool" } }],
    [fitSport.swimming, null, true, { sport: "swim", values: { water: "open_water" } }],
    [fitSport.alpineSkiing, fitSubSport.backcountry, true, { sport: "ski_touring", values: { kind: "touring" } }],
    [fitSport.alpineSkiing, fitSubSport.generic, true, { sport: "alpine_ski", values: { kind: "ski" } }],
    [fitSport.snowboarding, fitSubSport.generic, true, { sport: "alpine_ski", values: { kind: "snowboard" } }],
    [fitSport.crossCountrySkiing, fitSubSport.generic, true, { sport: "nordic_ski", values: { kind: "classic" } }],
    [fitSport.crossCountrySkiing, fitSubSport.skateSkiing, true, { sport: "nordic_ski", values: { kind: "skate" } }],
    [fitSport.kayaking, fitSubSport.generic, true, { sport: "paddle", values: { kind: "kayak" } }],
    [fitSport.paddling, fitSubSport.generic, true, { sport: "paddle", values: { kind: "canoe" } }],
    [fitSport.standUpPaddleboarding, fitSubSport.generic, true, { sport: "paddle", values: { kind: "sup" } }],
    [fitSport.rowing, fitSubSport.generic, true, { sport: "paddle", values: { kind: "rowing" } }],
    [fitSport.rowing, fitSubSport.indoorRowing, false, null],
    [fitSport.inlineSkating, fitSubSport.generic, true, { sport: "inline_skate", values: {} }],
  ])("maps FIT sport %i / %s", (sport, subSport, positioned, expected) => {
    expect(sportOfFit(sport, subSport, positioned)).toEqual(expected);
  });

  it("maps GPX types and TCX sports, and leaves unknown ones to the user", () => {
    expect(sportOfGpxType("Trail Running")).toEqual({ sport: "trail", values: {} });
    expect(sportOfGpxType("mountain_biking")).toEqual({ sport: "bike", values: { kind: "mtb" } });
    expect(sportOfGpxType("hike")).toEqual({ sport: "hike", values: {} });
    expect(sportOfGpxType("Backcountry Skiing")).toEqual({ sport: "ski_touring", values: { kind: "touring" } });
    expect(sportOfGpxType("cross_country_skiing")).toEqual({ sport: "nordic_ski", values: {} });
    expect(sportOfGpxType("Snowboarding")).toEqual({ sport: "alpine_ski", values: { kind: "snowboard" } });
    expect(sportOfGpxType("Stand-up paddling")).toEqual({ sport: "paddle", values: { kind: "sup" } });
    expect(sportOfGpxType("inline_skating")).toEqual({ sport: "inline_skate", values: {} });
    expect(sportOfGpxType("kitesurfing")).toBeNull();
    expect(sportOfFit(fitSport.running + 100, null, true)).toBeNull();
    expect(sportOfTcx("Biking")).toEqual({ sport: "bike", values: { kind: "road" } });
    expect(sportOfTcx("Other")).toBeNull();
  });
});
