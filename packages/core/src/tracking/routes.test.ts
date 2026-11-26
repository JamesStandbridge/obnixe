import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recording, route } from "@obnixe/schema";
import type { EpochMs, Id, Route } from "@obnixe/schema";
import { packSnapshot, unpackSnapshot } from "../data/backup/container.ts";
import { mergeSnapshot } from "../data/backup/merge.ts";
import { replaceWithSnapshot } from "../data/backup/replace.ts";
import { buildSnapshot, restorableTracks } from "../data/backup/snapshot.ts";
import { fixtures } from "../data/testFixtures.ts";
import type { Fixtures } from "../data/testFixtures.ts";
import { planTrashPurge, purgeExpiredTrash, restoreBlocker, trashItems, trashMutation } from "../data/trash.ts";
import { createTestContext, testUpgrader } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { processTrack } from "./batch.ts";
import type { ProcessedTrack } from "./batch.ts";
import { decodePolyline } from "./codec/polyline.ts";
import { decodeTrack, trackDigest } from "./codec/track.ts";
import { displace } from "./geo.ts";
import { planRecordingStart, recordingStartMutations, RouteUnavailableError } from "./plans.ts";
import type { RecordingStartRequest } from "./plans.ts";
import { referencedTrackFiles } from "./reconcile.ts";
import type { RoutePath } from "./route.ts";
import {
  activityRoute,
  distanceToRouteStart,
  encodeRoutePath,
  InvalidRouteError,
  newRoute,
  renameRoute,
  reverseRoute,
  routeGeometryOf,
  routeLibrary,
  routePathOf,
  routePathOfTrack,
  routeProblem,
  routeStart,
} from "./routes.ts";
import type { RouteDraft, RoutePlan, RoutePoint } from "./routes.ts";
import { coreScenarios } from "./testing/scenarios.ts";
import { profileOf, recordedLaps, untrimmed } from "./testing/run.ts";
import { toSampleColumns } from "./types.ts";

let context: TestContext;
let make: Fixtures;
let processed: ProcessedTrack;

const origin = { latitude: 45.1885, longitude: 5.7245 };

beforeAll(() => {
  const scenario = coreScenarios.steadyRun(4);
  const endT = scenario.samples.at(-1)?.t ?? 0;
  const track = { startedAt: Date.UTC(2026, 9, 24, 7, 30) as EpochMs, samples: toSampleColumns(scenario.samples), marks: [{ kind: "start", t: 0 } as const, { kind: "stop", t: endT } as const] };
  processed = processTrack(track, profileOf(scenario), { laps: recordedLaps, trim: untrimmed });
});

beforeEach(() => {
  context = createTestContext();
  make = fixtures(context);
});

function pointOf(east: number, north: number, altitude: number | null): RoutePoint {
  const position = displace(origin.latitude, origin.longitude, east, north);
  return { latitudeE7: Math.round(position.latitude * 1e7), longitudeE7: Math.round(position.longitude * 1e7), altitudeMm: altitude === null ? null : Math.round(altitude * 1000) };
}

/** 1 km east climbing 60 m, then 1 km north on the flat, a point every 20 m. */
function climbThenFlat(): RoutePath {
  const points: RoutePoint[] = [];
  for (let meters = 0; meters <= 1000; meters += 20) points.push(pointOf(meters, 0, 300 + meters * 0.06));
  for (let meters = 20; meters <= 1000; meters += 20) points.push(pointOf(1000, meters, 360));
  return routePathOf(points);
}

function draft(fields: Partial<RouteDraft> = {}): RouteDraft {
  return { name: "Bastille", sport: "run", path: climbThenFlat(), elevationSource: "barometer", sourceSessionId: null, ...fields };
}

function created(fields: Partial<RouteDraft> = {}): { readonly plan: RoutePlan; readonly row: Route } {
  const plan = newRoute(context.env, draft(fields));
  make.write([plan.mutation]);
  const row = context.db.select().from(route).where(eq(route.id, plan.routeId)).get();
  if (row === undefined) throw new Error("No route");
  return { plan, row };
}

function routeRow(id: Id): Route {
  const row = context.db.select().from(route).where(eq(route.id, id)).get();
  if (row === undefined) throw new Error("No route");
  return row;
}

function startRequest(fields: Partial<RecordingStartRequest>): RecordingStartRequest {
  return { sport: "run", values: {}, gearId: null, slot: null, timeZone: "Europe/Paris", routeId: null, ...fields };
}

describe("route creation (RTE-001)", () => {
  it("stores the route file and the measures of the path", () => {
    const { plan, row } = created();
    expect(plan.file.path).toBe(`routes/${plan.routeId}.otrk`);
    expect(plan.file.sha256).toBe(trackDigest(plan.file.bytes));
    expect(row).toMatchObject({ name: "Bastille", sport: "run", elevationSource: "barometer", reversed: false, trackFile: plan.file.path, trackSha256: plan.file.sha256, trackBytes: plan.file.bytes.length, pointCount: 101, lastUsedAt: null });
    expect(row.distanceMm).toBeGreaterThan(1_999_000);
    expect(row.distanceMm).toBeLessThan(2_001_000);
    expect(row.ascentMm).toBe(60_000);
    expect(row.descentMm).toBe(0);
    const decoded = routePathOfTrack(decodeTrack(plan.file.bytes));
    const path = climbThenFlat();
    expect(Array.from(decoded.latitudeE7)).toEqual(Array.from(path.latitudeE7));
    expect(Array.from(decoded.altitudeMm)).toEqual(Array.from(path.altitudeMm));
    expect(decodePolyline(row.previewPolyline, 5).length).toBe(3);
    expect(distanceToRouteStart(row, origin)).toBeLessThan(1);
  });

  it("redoes an activity from its smoothed positions and altitude", () => {
    const fromActivity = activityRoute(processed);
    expect(fromActivity.elevationSource).toBe(processed.summary.elevationSource);
    const { row } = created({ ...fromActivity, sourceSessionId: null });
    expect(Math.abs(row.distanceMm - processed.summary.distanceMm) / processed.summary.distanceMm).toBeLessThan(0.01);
    expect(row.ascentMm === null).toBe(processed.summary.ascentMm === null);
  });

  it("keeps no D+ without altitude", () => {
    const flat = routePathOf([pointOf(0, 0, null), pointOf(500, 0, null)]);
    const { row } = created({ path: flat, elevationSource: "gnss" });
    expect(row).toMatchObject({ elevationSource: "none", ascentMm: null, descentMm: null });
  });

  it("refuses an empty name, a sport without track and a route of one point", () => {
    expect(routeProblem(draft({ name: "  " }))).toBe("name");
    expect(routeProblem(draft({ sport: "strength" }))).toBe("sport");
    expect(routeProblem(draft({ path: routePathOf([pointOf(0, 0, null)]) }))).toBe("length");
    expect(routeProblem(draft())).toBeNull();
    expect(() => newRoute(context.env, draft({ sport: "yoga" }))).toThrow(InvalidRouteError);
  });

  it("renames a route, trimmed, and leaves it alone under the same name", () => {
    const { row } = created();
    expect(renameRoute(row, " Bastille ")).toBeNull();
    const mutation = renameRoute(row, " Moucherotte ");
    expect(mutation).toEqual({ kind: "update", table: "route", key: row.id, patch: { name: "Moucherotte" } });
    expect(() => renameRoute(row, "")).toThrow(InvalidRouteError);
  });
});

describe("route reversal (RTE-002)", () => {
  it("follows the file the other way and measures D+ and D- again", () => {
    const { plan, row } = created();
    const track = decodeTrack(plan.file.bytes);
    make.write([reverseRoute(row, track)]);
    const reversed = routeRow(row.id);
    expect(reversed).toMatchObject({ reversed: true, ascentMm: 0, descentMm: 60_000, distanceMm: row.distanceMm, trackSha256: row.trackSha256 });
    const end = routeStart(reversed);
    const last = displace(origin.latitude, origin.longitude, 1000, 1000);
    expect(Math.abs(end.latitude - last.latitude)).toBeLessThan(1e-5);
    const geometry = routeGeometryOf(reversed, track);
    expect(geometry.latitude[0]).toBeCloseTo(last.latitude, 6);
    expect(geometry.ascent).toBe(0);
    make.write([reverseRoute(reversed, track)]);
    expect(routeRow(row.id)).toMatchObject({ reversed: false, ascentMm: 60_000, descentMm: 0, previewPolyline: row.previewPolyline });
  });
});

describe("route library (RTE-002)", () => {
  it("lists the live routes of a sport in the order asked", () => {
    const long = created({ name: "Vercors" }).row;
    context.advance(1000);
    const short = created({ name: "abbaye", path: routePathOf([pointOf(0, 0, 200), pointOf(800, 0, 280)]) }).row;
    context.advance(1000);
    const ride = created({ name: "Col", sport: "bike" }).row;
    context.advance(1000);
    const trashed = created({ name: "Ancien" }).row;
    make.write([trashMutation("route", trashed.id, context.env.now())]);
    const names = (rows: readonly Route[]): readonly string[] => rows.map((row) => row.name);
    expect(names(routeLibrary(context.db, "recent", "run"))).toEqual(["abbaye", "Vercors"]);
    expect(names(routeLibrary(context.db, "name", null))).toEqual(["abbaye", "Col", "Vercors"]);
    expect(names(routeLibrary(context.db, "distance", "run"))).toEqual(["abbaye", "Vercors"]);
    expect(names(routeLibrary(context.db, "ascent", "run"))).toEqual(["Vercors", "abbaye"]);
    const plan = planRecordingStart(context.db, context.env, startRequest({ routeId: long.id }));
    make.write(recordingStartMutations(plan, { startedAt: context.env.now(), device: "Pixel 9 Pro" }));
    expect(names(routeLibrary(context.db, "recent", "run"))).toEqual(["Vercors", "abbaye"]);
    expect(ride.sport).toBe("bike");
    expect(short.ascentMm).toBe(80_000);
  });
});

describe("recording along a route (RTE-003)", () => {
  it("links the recording to the route and marks the route used", () => {
    const { row } = created();
    const plan = planRecordingStart(context.db, context.env, startRequest({ routeId: row.id }));
    const startedAt = context.env.now();
    make.write(recordingStartMutations(plan, { startedAt, device: "Pixel 9 Pro" }));
    expect(context.db.select({ routeId: recording.routeId }).from(recording).where(eq(recording.id, plan.recordingId)).get()).toEqual({ routeId: row.id });
    expect(routeRow(row.id).lastUsedAt).toBe(startedAt);
  });

  it("refuses a route of another sport, a trashed one and an unknown one", () => {
    const { row } = created({ sport: "bike" });
    expect(() => planRecordingStart(context.db, context.env, startRequest({ routeId: row.id }))).toThrow(RouteUnavailableError);
    const trashed = created().row;
    make.write([trashMutation("route", trashed.id, context.env.now())]);
    expect(() => planRecordingStart(context.db, context.env, startRequest({ routeId: trashed.id }))).toThrow(RouteUnavailableError);
    expect(() => planRecordingStart(context.db, context.env, startRequest({ routeId: context.env.newId() }))).toThrow(RouteUnavailableError);
  });
});

describe("routes in trash and backups", () => {
  it("restores a trashed route and purges it with its file, the recordings along it kept", () => {
    const { plan, row } = created();
    const start = planRecordingStart(context.db, context.env, startRequest({ routeId: row.id }));
    make.write(recordingStartMutations(start, { startedAt: context.env.now(), device: "Pixel 9 Pro" }));
    expect(referencedTrackFiles(context.db).has(plan.file.path)).toBe(true);
    make.write([trashMutation("route", row.id, context.env.now())]);
    const item = trashItems(context.db).find((candidate) => candidate.table === "route");
    if (item === undefined) throw new Error("No trash item");
    expect(item.row.id).toBe(row.id);
    expect(restoreBlocker(context.db, item)).toBeNull();
    context.advance(31 * 86_400_000);
    expect(planTrashPurge(context.db, context.env.now()).releases).toEqual([{ table: "recording", id: start.recordingId, patch: { routeId: null } }]);
    const purged = purgeExpiredTrash(context.db, context.env);
    expect(purged.trackFiles).toEqual([plan.file.path]);
    expect(context.db.select().from(route).all()).toEqual([]);
    expect(context.db.select({ routeId: recording.routeId }).from(recording).where(eq(recording.id, start.recordingId)).get()).toEqual({ routeId: null });
  });

  it("carries the route files and restores only those matching their row (DAT-030)", () => {
    const { plan, row } = created();
    const tracks = [{ kind: "route" as const, rowId: row.id, bytes: plan.file.bytes }];
    const snapshot = unpackSnapshot(packSnapshot(buildSnapshot(context.db, context.env.now(), [], tracks)), testUpgrader);
    expect(snapshot.tracks).toEqual(tracks);
    expect(restorableTracks(snapshot, null)).toEqual(tracks);
    expect(restorableTracks({ ...snapshot, tracks: [{ kind: "recording", rowId: row.id, bytes: plan.file.bytes }] }, null)).toEqual([]);
    expect(restorableTracks({ ...snapshot, tracks: [{ kind: "route", rowId: row.id, bytes: encodeRoutePath(climbThenFlat()).slice(1) }] }, null)).toEqual([]);

    const other = createTestContext();
    fixtures(other);
    const merged = mergeSnapshot(other.db, other.env, snapshot);
    expect(merged.trackRowIds).toEqual([row.id]);
    expect(other.db.select().from(route).all()).toMatchObject([{ id: row.id, trackFile: plan.file.path }]);

    replaceWithSnapshot(context.db, context.env, snapshot);
    expect(routeRow(row.id)).toMatchObject({ name: "Bastille", trackSha256: plan.file.sha256 });
  });
});
