import { describe, expect, it } from "vitest";
import { displace, ellipsoidDistance } from "./geo.ts";
import type { LiveSnapshot } from "./live.ts";
import { reverseRoutePath, RouteGeometry, RouteMatcher, routeMatching, routeProfile, RouteTooShortError } from "./route.ts";
import type { RouteEvent, RouteFix } from "./route.ts";
import { routePathOf } from "./routes.ts";
import type { RoutePoint } from "./routes.ts";
import { runLive, routeOfTruth } from "./testing/run.ts";
import type { LiveRun } from "./testing/run.ts";
import { detourLegMeters, routeScenarios } from "./testing/scenarios.ts";

const origin = { latitude: 45.1885, longitude: 5.7245 };

interface Offset {
  readonly east: number;
  readonly north: number;
  readonly altitude?: number;
}

function pointOf(offset: Offset): RoutePoint {
  const position = displace(origin.latitude, origin.longitude, offset.east, offset.north);
  return { latitudeE7: Math.round(position.latitude * 1e7), longitudeE7: Math.round(position.longitude * 1e7), altitudeMm: offset.altitude === undefined ? null : Math.round(offset.altitude * 1000) };
}

/** A route through the corners, a point every 10 m between them. */
function geometryOf(corners: readonly Offset[]): RouteGeometry {
  const points: RoutePoint[] = [];
  corners.forEach((corner, index) => {
    const next = corners[index + 1];
    if (next === undefined) {
      points.push(pointOf(corner));
      return;
    }
    const steps = Math.max(1, Math.round(Math.hypot(next.east - corner.east, next.north - corner.north) / 10));
    for (let step = 0; step < steps; step += 1) {
      const fraction = step / steps;
      points.push(pointOf({ east: corner.east + (next.east - corner.east) * fraction, north: corner.north + (next.north - corner.north) * fraction }));
    }
  });
  return new RouteGeometry(routePathOf(points), "none");
}

/** Positions every second at `speed` m/s through the corners. */
function walk(corners: readonly Offset[], speed: number, startT = 0): RouteFix[] {
  const fixes: RouteFix[] = [];
  let t = startT;
  corners.forEach((corner, index) => {
    const next = corners[index + 1];
    if (next === undefined) return;
    const length = Math.hypot(next.east - corner.east, next.north - corner.north);
    const velocityEast = (speed * (next.east - corner.east)) / length;
    const velocityNorth = (speed * (next.north - corner.north)) / length;
    for (let covered = 0; covered < length; covered += speed) {
      const fraction = covered / length;
      const position = displace(origin.latitude, origin.longitude, corner.east + (next.east - corner.east) * fraction, corner.north + (next.north - corner.north) * fraction);
      fixes.push({ t, ...position, accuracy: 4, velocityEast, velocityNorth });
      t += 1000;
    }
  });
  return fixes;
}

interface Followed {
  readonly matcher: RouteMatcher;
  readonly progress: readonly number[];
  readonly events: readonly RouteEvent[];
}

function follow(route: RouteGeometry, fixes: readonly RouteFix[]): Followed {
  const matcher = new RouteMatcher(route);
  const progress: number[] = [];
  const events: RouteEvent[] = [];
  for (const fix of fixes) {
    const event = matcher.push(fix);
    if (event !== null) events.push(event);
    progress.push(matcher.state.progress);
  }
  return { matcher, progress, events };
}

/** The largest fall of the progress below its running maximum, in meters. */
function largestSetback(progress: readonly number[]): number {
  let maximum = Number.NEGATIVE_INFINITY;
  let setback = 0;
  for (const value of progress) {
    maximum = Math.max(maximum, value);
    setback = Math.max(setback, maximum - value);
  }
  return setback;
}

describe("route profile", () => {
  it("measures the distance along the points and the D+ and D- by hysteresis", () => {
    const path = routePathOf([pointOf({ east: 0, north: 0, altitude: 100 }), pointOf({ east: 300, north: 0, altitude: 101 }), pointOf({ east: 300, north: 400, altitude: 130 }), pointOf({ east: 0, north: 400, altitude: 110 })]);
    const profile = routeProfile(path, "barometer");
    expect(profile.distance[3]).toBeCloseTo(1000, 0);
    expect(profile.ascent?.[3]).toBeCloseTo(30, 6);
    expect(profile.descent?.[3]).toBeCloseTo(20, 6);
    const gnss = routeProfile(path, "gnss");
    expect(gnss.ascent?.[1]).toBe(0);
    const none = routeProfile(path, "none");
    expect(none.ascent).toBeNull();
    expect(none.altitude).toBeNull();
  });

  it("drops the points within a meter of the previous one and keeps the end", () => {
    const path = routePathOf([pointOf({ east: 0, north: 0 }), pointOf({ east: 0.3, north: 0 }), pointOf({ east: 50, north: 0 }), pointOf({ east: 50.4, north: 0 })]);
    expect(path.length).toBe(2);
    expect(path.longitudeE7[1]).toBe(pointOf({ east: 50.4, north: 0 }).longitudeE7);
  });

  it("refuses a route without two distinct points", () => {
    expect(() => new RouteGeometry(routePathOf([pointOf({ east: 0, north: 0 }), pointOf({ east: 0.2, north: 0 })]), "none")).toThrow(RouteTooShortError);
  });

  it("reverses the points, the altitude with them", () => {
    const path = routePathOf([pointOf({ east: 0, north: 0, altitude: 100 }), pointOf({ east: 100, north: 0, altitude: 120 })]);
    const reversed = reverseRoutePath(path);
    expect(Array.from(reversed.altitudeMm)).toEqual([120_000, 100_000]);
    expect(Array.from(reversed.longitudeE7)).toEqual(Array.from(path.longitudeE7).reverse());
  });
});

describe("route matcher", () => {
  const straight = geometryOf([
    { east: 0, north: 0 },
    { east: 2000, north: 0 },
  ]);

  it("follows the progress along the route and the distance left (RTE-004)", () => {
    const { matcher, progress } = follow(straight, walk([{ east: 0, north: 5 }, { east: 1200, north: 5 }], 3));
    const state = matcher.state;
    expect(state.joined).toBe(true);
    expect(state.matched).toBe(true);
    expect(state.progress).toBeGreaterThan(1190);
    expect(state.remaining).toBeCloseTo(straight.meters - state.progress, 6);
    expect(state.distance ?? 0).toBeCloseTo(5, 0);
    expect(largestSetback(progress)).toBeLessThan(0.5);
  });

  it("joins the route nearest its start, never before a position comes within the match distance", () => {
    const matcher = new RouteMatcher(straight);
    expect(matcher.push({ t: 0, ...displace(origin.latitude, origin.longitude, 300, 120), accuracy: 4, velocityEast: 0, velocityNorth: 0 })).toBeNull();
    expect(matcher.state.joined).toBe(false);
    expect(matcher.state.distance ?? 0).toBeCloseTo(120, 0);
    matcher.push({ t: 1000, ...displace(origin.latitude, origin.longitude, 300, 20), accuracy: 4, velocityEast: 0, velocityNorth: 0 });
    expect(matcher.state.joined).toBe(true);
    expect(matcher.state.progress).toBeCloseTo(300, 0);
  });

  it("starts a loop at its start where its end passes too", () => {
    const loop = geometryOf([
      { east: 0, north: 0 },
      { east: 500, north: 0 },
      { east: 500, north: 500 },
      { east: 0, north: 500 },
      { east: 0, north: 0 },
    ]);
    const matcher = new RouteMatcher(loop);
    matcher.push({ t: 0, ...displace(origin.latitude, origin.longitude, 10, 8), accuracy: 4, velocityEast: 0, velocityNorth: 0 });
    expect(matcher.state.progress).toBeCloseTo(10, 0);
  });

  it("takes the route up again after a shortcut, in the direction of travel (RTE-004)", () => {
    const hairpin = geometryOf([
      { east: 0, north: 0 },
      { east: 1000, north: 0 },
      { east: 1000, north: 300 },
      { east: 0, north: 300 },
    ]);
    const shortcut = walk(
      [
        { east: 0, north: 0 },
        { east: 500, north: 0 },
        { east: 500, north: 300 },
        { east: 0, north: 300 },
      ],
      3,
    );
    const { matcher } = follow(hairpin, shortcut);
    expect(matcher.state.matched).toBe(true);
    expect(matcher.state.progress).toBeGreaterThan(2250);
  });

  it("signals the exit after 10 s beyond 40 m and the return after 5 s within 25 m, with the way back (RTE-005)", () => {
    const fixes = walk(
      [
        { east: 0, north: 0 },
        { east: 600, north: 0 },
        { east: 600, north: 150 },
        { east: 900, north: 150 },
        { east: 900, north: 0 },
        { east: 1500, north: 0 },
      ],
      3,
    );
    const matcher = new RouteMatcher(straight);
    const events: RouteEvent[] = [];
    let farSince: number | null = null;
    let nearSince: number | null = null;
    let rejoinSeen = false;
    for (const fix of fixes) {
      const event = matcher.push(fix);
      if (event !== null) events.push(event);
      const north = ellipsoidDistance(fix.latitude, fix.longitude, origin.latitude, fix.longitude);
      if (farSince === null && north > routeMatching.offRouteMeters) farSince = fix.t;
      if (farSince !== null && nearSince === null && events.length > 0 && north < routeMatching.backOnRouteMeters) nearSince = fix.t;
      const { state } = matcher;
      if (state.offRoute && state.rejoin !== null) {
        rejoinSeen = true;
        expect(state.rejoin.progress).toBeGreaterThanOrEqual(state.progress);
        expect(state.rejoin.distance).toBeCloseTo(north, 0);
        if (north > 140) expect(Math.abs(state.rejoin.bearing - 180)).toBeLessThan(5);
      }
    }
    expect(events.map((event) => event.type)).toEqual(["off_route", "back_on_route"]);
    expect((events[0]?.t ?? 0) - (farSince ?? 0)).toBe(routeMatching.offRouteMs);
    expect((events[1]?.t ?? 0) - (nearSince ?? 0)).toBe(routeMatching.backOnRouteMs);
    expect(rejoinSeen).toBe(true);
    expect(matcher.state.rejoin).toBeNull();
  });

  it("never signals an exit before joining the route", () => {
    const { events, matcher } = follow(straight, walk([{ east: 0, north: 400 }, { east: 1000, north: 400 }], 3));
    expect(events).toEqual([]);
    expect(matcher.state.joined).toBe(false);
  });

  it("raises the exit threshold to twice the accuracy", () => {
    const matcher = new RouteMatcher(straight);
    matcher.push({ t: 0, ...origin, accuracy: 4, velocityEast: 3, velocityNorth: 0 });
    let events = 0;
    for (let second = 1; second <= 30; second += 1) {
      const position = displace(origin.latitude, origin.longitude, 3 * second, 45);
      if (matcher.push({ t: second * 1000, ...position, accuracy: 30, velocityEast: 3, velocityNorth: 0 }) !== null) events += 1;
    }
    expect(events).toBe(0);
    expect(matcher.state.offRoute).toBe(false);
  });

  it("gives the D+ left from the progress", () => {
    const climb = new RouteGeometry(
      routePathOf([pointOf({ east: 0, north: 0, altitude: 100 }), pointOf({ east: 500, north: 0, altitude: 150 }), pointOf({ east: 1000, north: 0, altitude: 200 })]),
      "barometer",
    );
    const matcher = new RouteMatcher(climb);
    matcher.push({ t: 0, ...origin, accuracy: 4, velocityEast: 0, velocityNorth: 0 });
    matcher.push({ t: 1000, ...displace(origin.latitude, origin.longitude, 2, 0), accuracy: 4, velocityEast: 2, velocityNorth: 0 });
    for (const fix of walk([{ east: 2, north: 0 }, { east: 500, north: 0 }], 3, 2000)) matcher.push(fix);
    expect(matcher.state.remainingAscent ?? 0).toBeCloseTo(50, -1);
  });
});

function routeOf(snapshot: LiveSnapshot): NonNullable<LiveSnapshot["route"]> {
  if (snapshot.route === null) throw new Error("No route followed");
  return snapshot.route;
}

function progressOf(run: LiveRun): readonly number[] {
  return run.snapshots.map((snapshot) => routeOf(snapshot).progress);
}

interface DetourDelays {
  /** From the true position passing `offRouteMeters` off the route to the exit signal. */
  readonly exit: number;
  /** From the true position coming back within `backOnRouteMeters` to the return signal. */
  readonly back: number;
}

/** The fix noise moves the measured crossing of a threshold by up to this much at running speed, earlier or later. */
const positionNoiseMs = 3000;

function detourDelays(seed: number): DetourDelays {
  const scenario = routeScenarios.detour(seed);
  const route = routeOfTruth(scenario.planned);
  const run = runLive(scenario, [], null, route);
  const { truth } = scenario;
  const offset = (index: number): number => ellipsoidDistance(truth.latitude[index] ?? 0, truth.longitude[index] ?? 0, route.latitude[0] ?? 0, truth.longitude[index] ?? 0);
  const firstFrom = (from: number, test: (distance: number) => boolean): number => {
    for (let index = from; index < truth.length; index += 1) if (test(offset(index))) return index;
    throw new Error("The detour never crosses the threshold");
  };
  const left = firstFrom(0, (distance) => distance > routeMatching.offRouteMeters);
  const back = firstFrom(
    firstFrom(left, (distance) => distance > detourLegMeters - 1),
    (distance) => distance < routeMatching.backOnRouteMeters,
  );
  const events = run.events.map(({ event }) => event).filter((event): event is RouteEvent => event.type === "off_route" || event.type === "back_on_route");
  expect(events.map((event) => event.type)).toEqual(["off_route", "back_on_route"]);
  expect(routeOf(run.final).fraction).toBeGreaterThan(0.99);
  return { exit: (events[0]?.t ?? 0) - (truth.t[left] ?? 0), back: (events[1]?.t ?? 0) - (truth.t[back] ?? 0) };
}

describe("route scenarios", () => {
  it.each([1, 2, 3])("route-out-and-back: progress goes on past the middle and stays monotone (RTE-004, seed %i)", (seed) => {
    const scenario = routeScenarios.outAndBack(seed);
    const route = routeOfTruth(scenario.planned);
    const run = runLive(scenario, [], null, route);
    const progress = progressOf(run);
    expect(largestSetback(progress)).toBeLessThan(10);
    const half = route.meters / 2;
    const middle = progress.findIndex((value) => value >= half - 30);
    expect(middle).toBeGreaterThan(0);
    expect(progress.slice(middle).every((value) => value >= half - 40)).toBe(true);
    expect(routeOf(run.final).fraction).toBeGreaterThan(0.98);
    expect(run.events.filter(({ event }) => event.type === "off_route")).toEqual([]);
  });

  it.each([1, 2, 3])("route-figure-eight: progress stays monotone through the crossing, without false exit (seed %i)", (seed) => {
    const scenario = routeScenarios.figureEight(seed);
    const route = routeOfTruth(scenario.planned);
    const run = runLive(scenario, [], null, route);
    expect(largestSetback(progressOf(run))).toBeLessThan(10);
    expect(routeOf(run.final).fraction).toBeGreaterThan(0.98);
    expect(run.events.filter(({ event }) => event.type === "off_route" || event.type === "back_on_route")).toEqual([]);
  });

  it("route-detour: the exit comes 10 to 14 s after leaving, the return 5 to 8 s after coming back (RTE-005)", () => {
    const seeds = Array.from({ length: 12 }, (_, index) => index + 1);
    const delays = seeds.map((seed) => detourDelays(seed));
    const median = (values: readonly number[]): number => {
      const sorted = [...values].sort((left, right) => left - right);
      return ((sorted[(sorted.length - 1) >> 1] ?? 0) + (sorted[sorted.length >> 1] ?? 0)) / 2;
    };
    const exits = delays.map((delay) => delay.exit);
    const returns = delays.map((delay) => delay.back);
    expect(median(exits)).toBeGreaterThanOrEqual(10_000);
    expect(median(exits)).toBeLessThanOrEqual(14_000);
    expect(median(returns)).toBeGreaterThanOrEqual(5_000);
    expect(median(returns)).toBeLessThanOrEqual(8_000);
    expect(Math.min(...exits)).toBeGreaterThanOrEqual(routeMatching.offRouteMs - positionNoiseMs);
    expect(Math.max(...exits)).toBeLessThanOrEqual(14_000);
    expect(Math.min(...returns)).toBeGreaterThanOrEqual(routeMatching.backOnRouteMs - positionNoiseMs);
    expect(Math.max(...returns)).toBeLessThanOrEqual(8_000);
  });
});
