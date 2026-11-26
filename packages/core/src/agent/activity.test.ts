import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bestEffort, session, settings } from "@obnixe/schema";
import type { BestEffortKey, EpochMs, Id, LocalDate, Session } from "@obnixe/schema";
import { fixtures } from "../data/testFixtures.ts";
import type { Fixtures } from "../data/testFixtures.ts";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { processTrack } from "../tracking/batch.ts";
import type { ProcessedTrack } from "../tracking/batch.ts";
import { encodeTrack } from "../tracking/codec/track.ts";
import type { Track } from "../tracking/codec/track.ts";
import { ellipsoidDistance } from "../tracking/geo.ts";
import { profileOf, recordedLaps, trackOf, untrimmed } from "../tracking/testing/run.ts";
import { mountainOuting } from "../tracking/testing/scenarios.ts";
import type { NewRow } from "../writer.ts";
import { sampleTrack } from "./activity.ts";
import { openConnection, readPermissions } from "./connection.ts";
import { exposedToolNames } from "./contract.ts";
import { runAgentTool } from "./dispatch.ts";
import type { TrackReader } from "./environment.ts";
import type { ToolOutcome } from "./protocol.ts";
import { answerMcpMessage } from "./remote/mcp.ts";

const timeZone = "Europe/Paris";
const trackFile = "tracks/outing.otrk";
const startedAt = 1_780_000_000_000 as EpochMs;

let track: Track;
let bytes: Uint8Array;
let processed: ProcessedTrack;

beforeAll(() => {
  track = trackOf(mountainOuting(1, 11).samples);
  bytes = encodeTrack(track);
  processed = processTrack(track, profileOf({ sport: "trail" }), { laps: recordedLaps, trim: untrimmed });
});

let context: TestContext;
let make: Fixtures;
let connectionId: Id;
let readTrack: TrackReader;

beforeEach(() => {
  context = createTestContext();
  make = fixtures(context);
  connectionId = openConnection(context.db, context.env, { client: "Cursor", host: "MacBook Pro" });
  readTrack = (file) => (file === trackFile ? bytes : null);
});

function call(tool: string, args: unknown): ToolOutcome {
  return runAgentTool(context.db, context.env, { connectionId, tool, arguments: args, timeZone, readTrack });
}

function ok<T>(tool: string, args: unknown): T {
  const outcome = call(tool, args);
  if (outcome.isError) throw new Error(`${tool} failed: ${outcome.text}`);
  return JSON.parse(outcome.text) as T;
}

function failure(tool: string, args: unknown): string {
  const outcome = call(tool, args);
  expect(outcome.isError).toBe(true);
  return outcome.text;
}

function setSettings(patch: Partial<typeof settings.$inferInsert>): void {
  context.db.update(settings).set(patch).run();
}

const values = { kind: "training", distance: 9408, elevation_gain: 600, heart_rate_avg: 146 };

function outing(overrides: Partial<NewRow<"session">> = {}): NewRow<"session"> {
  return make.session({ sport: "trail", values, startedAt, endedAt: (startedAt + 3_840_000) as EpochMs, localDate: "2026-05-28" as LocalDate, ...overrides });
}

function recordingOf(sessionId: Id, overrides: Partial<NewRow<"recording">> = {}): NewRow<"recording"> {
  return {
    id: context.env.newId(),
    sessionId,
    source: "live",
    importFormat: null,
    externalId: null,
    device: "Pixel 9 Pro",
    algorithmVersion: 1,
    autoPause: true,
    elevationSource: "barometer",
    cadenceSource: "pedometer",
    heartRateSource: "sensor",
    simulated: false,
    trimStartMs: 0,
    trimEndMs: null,
    elapsedMs: 3_840_000,
    movingMs: 3_600_000,
    distanceMm: 9_408_000,
    ascentMm: 600_000,
    descentMm: 598_000,
    altitudeMinMm: 900_000,
    altitudeMaxMm: 1_200_000,
    speedMaxMmS: 3100,
    cadenceAvg: 165,
    steps: 9900,
    heartRateAvg: 146,
    heartRateMax: 161,
    heartRateDevice: "Venue 3S",
    energyKcal: 812,
    energyMethod: "heart_rate",
    importedEnergyKcal: null,
    weather: null,
    goodFixPermille: 990,
    bbox: { south: 451_800_000, west: 57_200_000, north: 452_000_000, east: 57_300_000 },
    previewPolyline: null,
    trackFile,
    trackSha256: "0".repeat(64),
    trackBytes: bytes.length,
    pointCount: 3840,
    ...overrides,
  };
}

function recorded(overrides: Partial<NewRow<"session">> = {}, recordingOverrides: Partial<NewRow<"recording">> = {}): NewRow<"session"> {
  const row = outing(overrides);
  make.write([
    { kind: "insert", table: "session", row },
    { kind: "insert", table: "recording", row: recordingOf(row.id, recordingOverrides) },
  ]);
  return row;
}

function effort(sessionId: Id, key: BestEffortKey, elapsedMs: number, ascentMm: number | null = null): void {
  context.db.insert(bestEffort).values({ sessionId, effort: key, elapsedMs, movingMs: elapsedMs, startOffsetMs: 60_000, ascentMm, algorithmVersion: 1 }).run();
}

interface HistoryRecording {
  readonly source: string;
  readonly distanceMeters: number;
  readonly movingSeconds: number;
  readonly paceSecondsPerKm: number | null;
  readonly averageSpeedKmh: number | null;
  readonly heartRateAvg: number | null;
  readonly energyKcal: number | null;
  readonly hasTrack: boolean;
  readonly laps: readonly { readonly trigger: string; readonly workoutStep: number | null; readonly startOffsetSeconds: number; readonly endOffsetSeconds: number }[];
  readonly bestEfforts: readonly { readonly effort: string; readonly elapsedSeconds: number; readonly ascentMeters: number | null; readonly record: string | null }[];
}

interface History {
  readonly sessions: readonly { readonly id: string; readonly recording: HistoryRecording | null }[];
}

describe("get_history", () => {
  it("summarizes recorded activities without positions and leaves the other sessions without recording", () => {
    const run = recorded();
    make.write([{ kind: "insert", table: "lap", row: { id: context.env.newId(), sessionId: run.id, position: 0, trigger: "manual", startOffsetMs: 0, endOffsetMs: 1_200_000 } }]);
    const strength = make.session({ localDate: "2026-05-27" as LocalDate });
    make.write([{ kind: "insert", table: "session", row: strength }]);
    const history = ok<History>("get_history", { from: "2026-05-01", to: "2026-05-31" });
    const summary = history.sessions.find((row) => row.id === run.id)?.recording;
    expect(summary).toMatchObject({ source: "live", distanceMeters: 9408, movingSeconds: 3600, paceSecondsPerKm: 383, averageSpeedKmh: 9.4, heartRateAvg: 146, energyKcal: 812, hasTrack: true });
    expect(summary?.laps).toEqual([{ trigger: "manual", workoutStep: null, startOffsetSeconds: 0, endOffsetSeconds: 1200 }]);
    expect(history.sessions.find((row) => row.id === strength.id)?.recording).toBeNull();
    const text = call("get_history", { from: "2026-05-01", to: "2026-05-31" }).text;
    expect(text).not.toMatch(/latitude|longitude|polyline|bbox/i);
  });

  it("marks the best efforts that set a record, current or beaten since, over every completed activity", () => {
    const first = recorded({ startedAt: (startedAt - 2 * 86_400_000) as EpochMs, localDate: "2026-05-26" as LocalDate });
    const second = recorded({ startedAt: (startedAt - 86_400_000) as EpochMs, localDate: "2026-05-27" as LocalDate });
    const third = recorded();
    const trashed = recorded({ startedAt: (startedAt - 3 * 86_400_000) as EpochMs, localDate: "2026-05-25" as LocalDate, deletedAt: context.env.now() });
    effort(trashed.id, "trail:distance:1000", 200_000);
    effort(first.id, "trail:distance:1000", 300_000);
    effort(second.id, "trail:distance:1000", 280_000);
    effort(third.id, "trail:distance:1000", 320_000);
    effort(first.id, "trail:ascent_1h", 3_600_000, 700_000);
    effort(third.id, "trail:ascent_1h", 3_600_000, 650_000);
    const history = ok<History>("get_history", { from: "2026-05-01", to: "2026-05-31" });
    const efforts = (id: string) => history.sessions.find((row) => row.id === id)?.recording?.bestEfforts;
    expect(efforts(first.id)).toEqual([
      { effort: "trail:ascent_1h", elapsedSeconds: 3600, movingSeconds: 3600, startOffsetSeconds: 60, ascentMeters: 700, record: "current" },
      { effort: "trail:distance:1000", elapsedSeconds: 300, movingSeconds: 300, startOffsetSeconds: 60, ascentMeters: null, record: "former" },
    ]);
    expect(efforts(second.id)?.map((item) => item.record)).toEqual(["current"]);
    expect(efforts(third.id)?.map((item) => item.record)).toEqual([null, null]);
  });
});

interface Stretch {
  readonly distanceMeters: number;
  readonly movingSeconds: number;
  readonly paceSecondsPerKm: number | null;
  readonly gradeAdjustedPaceSecondsPerKm: number | null;
  readonly heartRateAvg: number | null;
}

interface Activity {
  readonly recording: HistoryRecording;
  readonly gradeAdjustedPaceSecondsPerKm: number | null;
  readonly vamMetersPerHour: number | null;
  readonly splits: readonly (Stretch & { readonly index: number })[];
  readonly laps: readonly (Stretch & { readonly trigger: string })[];
  readonly heartRateZones: {
    readonly maxHeartRate: number;
    readonly maxHeartRateSource: string;
    readonly coveredSeconds: number;
    readonly belowZone1Seconds: number;
    readonly zones: readonly { readonly zone: number; readonly minBpm: number; readonly maxBpm: number; readonly seconds: number }[];
  } | null;
  readonly dataQuality: { readonly heartRateCoveragePermille: number | null };
}

describe("get_activity", () => {
  it("derives splits, laps, grade-adjusted pace and heart-rate zones from the stored track", () => {
    setSettings({ maxHeartRate: 190 });
    const run = recorded();
    make.write([
      { kind: "insert", table: "lap", row: { id: context.env.newId(), sessionId: run.id, position: 0, trigger: "manual", startOffsetMs: 0, endOffsetMs: 1_800_000 } },
      { kind: "insert", table: "lap", row: { id: context.env.newId(), sessionId: run.id, position: 1, trigger: "manual", startOffsetMs: 1_800_000, endOffsetMs: 3_840_000 } },
    ]);
    const activity = ok<Activity>("get_activity", { sessionId: run.id });
    expect(activity.splits.map((split) => split.index)).toEqual(processed.splits.map((split) => split.index));
    expect(activity.splits.reduce((total, split) => total + split.distanceMeters, 0)).toBeCloseTo(processed.summary.distanceMm / 1000, -1);
    expect(activity.splits[0]?.paceSecondsPerKm).toBeGreaterThan(0);
    expect(activity.splits[0]?.gradeAdjustedPaceSecondsPerKm).not.toBeNull();
    expect(activity.laps.map((item) => item.trigger)).toEqual(["manual", "manual"]);
    expect(activity.gradeAdjustedPaceSecondsPerKm).not.toBeNull();
    expect(activity.vamMetersPerHour).toBeGreaterThan(0);
    const zones = activity.heartRateZones;
    expect(zones).toMatchObject({ maxHeartRate: 190, maxHeartRateSource: "settings" });
    expect(zones?.zones.map((zone) => [zone.minBpm, zone.maxBpm])).toEqual([
      [95, 114],
      [114, 133],
      [133, 152],
      [152, 171],
      [171, 190],
    ]);
    const zoned = (zones?.zones ?? []).reduce((total, zone) => total + zone.seconds, 0) + (zones?.belowZone1Seconds ?? 0);
    expect(Math.abs(zoned - (zones?.coveredSeconds ?? 0))).toBeLessThanOrEqual(5);
    expect(zones?.coveredSeconds).toBeGreaterThan(3000);
    expect(activity.recording.distanceMeters).toBe(9408);
  });

  it("leaves heart-rate zones null without a maximum or a birth year", () => {
    const run = recorded();
    expect(ok<Activity>("get_activity", { sessionId: run.id }).heartRateZones).toBeNull();
  });

  it("explains why an activity cannot be analysed", () => {
    const manual = outing();
    make.write([{ kind: "insert", table: "session", row: manual }]);
    expect(failure("get_activity", { sessionId: manual.id })).toMatch(/has no track/);
    const gone = recorded({}, { trackFile: "tracks/elsewhere.otrk" });
    expect(failure("get_activity", { sessionId: gone.id })).toMatch(/cannot be read on this phone/);
    readTrack = () => Uint8Array.of(1, 2, 3);
    expect(failure("get_activity", { sessionId: gone.id })).toMatch(/is damaged/);
    expect(failure("get_activity", { sessionId: "missing" })).toMatch(/No session/);
  });
});

interface ActivityTrack {
  readonly startedAt: string;
  readonly masked: boolean;
  readonly pointCount: number;
  readonly fields: readonly string[];
  readonly segments: readonly (readonly (readonly (number | null)[])[])[];
}

function points(result: ActivityTrack): readonly (readonly (number | null)[])[] {
  return result.segments.flat();
}

function seriesPoint(fraction: number): { readonly latitude: number; readonly longitude: number } {
  const index = Math.floor(processed.series.length * fraction);
  return { latitude: processed.series.latitude[index] ?? 0, longitude: processed.series.longitude[index] ?? 0 };
}

function zoneAt(center: { readonly latitude: number; readonly longitude: number }, radiusMeters: number, deletedAt: EpochMs | null = null): NewRow<"privacy_zone"> {
  return { id: context.env.newId(), label: "Maison", latitudeE7: Math.round(center.latitude * 1e7), longitudeE7: Math.round(center.longitude * 1e7), radiusMeters, maskScalePermille: 1000, deletedAt };
}

function alongTrack(): readonly number[] {
  const { latitude, longitude, length } = processed.series;
  const along = [0];
  for (let index = 1; index < length; index += 1) {
    along.push((along[index - 1] ?? 0) + ellipsoidDistance(latitude[index - 1] ?? 0, longitude[index - 1] ?? 0, latitude[index] ?? 0, longitude[index] ?? 0));
  }
  return along;
}

function seriesIndexAt(elapsedSeconds: number): number {
  return processed.series.t.findIndex((t) => Math.round((t - processed.elapsed.startMs) / 1000) === elapsedSeconds);
}

function nearest(result: ActivityTrack, center: { readonly latitude: number; readonly longitude: number }): number {
  return Math.min(...points(result).map((point) => ellipsoidDistance(center.latitude, center.longitude, point[1] ?? 0, point[2] ?? 0)));
}

describe("get_activity_track", () => {
  it("returns at most 1000 points by default with time, position, distance, altitude, pace and heart rate", () => {
    const run = recorded();
    const result = ok<ActivityTrack>("get_activity_track", { sessionId: run.id });
    expect(result.fields).toEqual(["elapsedSeconds", "latitude", "longitude", "distanceMeters", "altitudeMeters", "paceSecondsPerKm", "heartRate"]);
    expect(result.pointCount).toBeLessThanOrEqual(1000);
    expect(result.pointCount).toBeGreaterThan(800);
    expect(points(result)).toHaveLength(result.pointCount);
    expect(result.masked).toBe(false);
    expect(result.segments).toHaveLength(1);
    expect(result.startedAt).toBe(new Date(startedAt + processed.elapsed.startMs).toISOString());
    const elapsed = points(result).map((point) => point[0] ?? 0);
    expect(elapsed).toEqual([...elapsed].sort((left, right) => left - right));
    expect(points(result).filter((point) => point[6] !== null).length).toBeGreaterThan(900);
    expect(points(result).every((point) => point[4] !== null)).toBe(true);
    expect(ok<ActivityTrack>("get_activity_track", { sessionId: run.id, maxPoints: 50 }).pointCount).toBeLessThanOrEqual(50);
  });

  it("never returns a point inside an active privacy zone or near the hidden ends, and ignores zones in the trash", () => {
    const home = seriesPoint(0.5);
    const former = seriesPoint(0.25);
    make.write([
      { kind: "insert", table: "privacy_zone", row: zoneAt(home, 200) },
      { kind: "insert", table: "privacy_zone", row: zoneAt(former, 150, context.env.now()) },
    ]);
    setSettings({ hideTrackEndsMeters: 300 });
    const run = recorded();
    const result = ok<ActivityTrack>("get_activity_track", { sessionId: run.id });
    expect(result.masked).toBe(true);
    expect(nearest(result, home)).toBeGreaterThan(200);
    expect(nearest(result, former)).toBeLessThan(150);
    expect(result.segments.length).toBeGreaterThanOrEqual(2);
    const along = alongTrack();
    const total = along.at(-1) ?? 0;
    const first = along[seriesIndexAt(points(result)[0]?.[0] ?? 0)] ?? 0;
    const last = along[seriesIndexAt(points(result).at(-1)?.[0] ?? 0)] ?? 0;
    expect(first).toBeGreaterThanOrEqual(295);
    expect(total - last).toBeGreaterThanOrEqual(295);
  });

  it("is refused and hidden from the exposed tools once the user stops sharing tracks", () => {
    const run = recorded();
    expect(exposedToolNames(readPermissions(context.db))).toContain("get_activity_track");
    setSettings({ agentCanReadLocation: false });
    expect(failure("get_activity_track", { sessionId: run.id })).toMatch(/Lire les traces/);
    const exposed = exposedToolNames(readPermissions(context.db));
    expect(exposed).not.toContain("get_activity_track");
    expect(exposed).toContain("get_activity");
    expect(exposed).toContain("log_weigh_in");
    const reply = answerMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { runTool: () => ({ text: "", isError: true }), exposedTools: () => exposed });
    const listed = reply !== null && "result" in reply ? (reply.result as { readonly tools: readonly { readonly name: string }[] }).tools.map((tool) => tool.name) : [];
    expect(listed).toEqual(exposed);
    expect(ok<Activity>("get_activity", { sessionId: run.id }).splits.length).toBeGreaterThan(0);
  });
});

describe("sampleTrack", () => {
  it("keeps the extremes of speed and altitude among the visible points only", () => {
    const length = 5000;
    const t = Float64Array.from({ length }, (_, index) => index * 1000);
    const speed = Float32Array.from({ length }, (_, index) => (index === 1234 ? 9 : 3 + Math.sin(index / 50)));
    const altitude = Float32Array.from({ length }, (_, index) => (index === 3210 ? 2000 : index % 7 === 0 ? Number.NaN : 1000 + index / 10));
    const kept = sampleTrack({ t, speed, altitude }, [{ start: 0, end: 2000 }, { start: 2500, end: length }], 200);
    expect(kept.length).toBeLessThanOrEqual(200);
    expect([...kept]).toContain(1234);
    expect([...kept]).toContain(3210);
    expect([...kept].every((index) => index < 2000 || index >= 2500)).toBe(true);
    expect([...kept]).toEqual([...kept].sort((left, right) => left - right));
  });
});

describe("update_session on a recorded activity", () => {
  beforeEach(() => setSettings({ agentCanWrite: true }));

  function stored(id: Id): Session | undefined {
    return context.db.select().from(session).where(eq(session.id, id)).get();
  }

  it("refuses to change the values measured on the track, and the timing", () => {
    const run = recorded();
    expect(failure("update_session", { sessionId: run.id, values: { ...values, distance: 12000 } })).toMatch(/distance come from its track/);
    expect(failure("update_session", { sessionId: run.id, values: { kind: "race", distance: 9408, heart_rate_avg: 146 } })).toMatch(/elevation_gain come from its track/);
    expect(failure("update_session", { sessionId: run.id, durationSeconds: 3000 })).toMatch(/start time and duration come from the track/);
    expect(stored(run.id)?.values).toEqual(values);
  });

  it("refuses values that would make a GPS recording unrecordable", () => {
    const ride = recorded({ sport: "bike", values: { kind: "road", distance: 9408, elevation_gain: 600, heart_rate_avg: 146 } });
    expect(failure("update_session", { sessionId: ride.id, values: { kind: "indoor", distance: 9408, elevation_gain: 600, heart_rate_avg: 146 } })).toMatch(/must keep a bike kind that records a track/);
  });

  it("changes the kind of outing, title, note and feelings", () => {
    const run = recorded();
    const result = ok<{ readonly changed: readonly string[] }>("update_session", { sessionId: run.id, values: { ...values, kind: "race" }, title: "Trail des Vouillants", note: "Bonnes jambes", effort: "hard" });
    expect(result.changed).toEqual(expect.arrayContaining(["values", "title", "note", "effort"]));
    expect(stored(run.id)).toMatchObject({ values: { ...values, kind: "race" }, title: "Trail des Vouillants", note: "Bonnes jambes", effort: "hard" });
  });
});
