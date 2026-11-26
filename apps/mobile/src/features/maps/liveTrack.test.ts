import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTrack } from "@/features/maps/liveTrack";
import type { LiveStretch } from "@/features/maps/liveTrack";

interface Feature {
  readonly properties: { readonly kind: string; readonly accuracy0?: number; readonly bearing?: number };
  readonly geometry: { readonly type: string; readonly coordinates: unknown };
}

interface Collection {
  readonly features: readonly Feature[];
}

function parse(text: string): Collection {
  return JSON.parse(text) as Collection;
}

function point(latitude: number, longitude: number, stretch: LiveStretch = "moving") {
  return { latitude, longitude, stretch };
}

describe("LiveTrack (MAP-010)", () => {
  let clock = 0;
  const now = (): number => clock;

  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function advance(ms: number): void {
    clock += ms;
    vi.advanceTimersByTime(ms);
  }

  it("publishes the first point at once and then at most once per second", () => {
    const track = new LiveTrack(now);
    const listener = vi.fn();
    track.subscribe(listener);
    track.push(point(45.9, 6.87));
    expect(listener).toHaveBeenCalledTimes(1);
    track.push(point(45.9001, 6.87));
    track.push(point(45.9002, 6.87));
    expect(listener).toHaveBeenCalledTimes(1);
    advance(999);
    expect(listener).toHaveBeenCalledTimes(1);
    advance(1);
    expect(listener).toHaveBeenCalledTimes(2);
    const line = parse(track.frame().track).features[0];
    expect(line?.geometry).toEqual({ type: "LineString", coordinates: [[6.87, 45.9], [6.87, 45.9001], [6.87, 45.9002]] });
    track.dispose();
  });

  it("drops fixes closer than two meters to the previous point", () => {
    const track = new LiveTrack(now);
    track.push(point(45.9, 6.87));
    track.push(point(45.900005, 6.87));
    advance(1000);
    expect(parse(track.frame().track).features).toEqual([]);
    expect(parse(track.frame().points).features.map((feature) => feature.properties.kind)).toEqual(["start"]);
  });

  it("keeps one continuous line and lists the interrupted stretches from the last point before the gap", () => {
    const track = new LiveTrack(now);
    track.push(point(45.9, 6.87));
    track.push(point(45.901, 6.87));
    track.push(point(45.902, 6.871, "interrupted"));
    track.push(point(45.903, 6.872, "interrupted"));
    track.push(point(45.904, 6.872));
    track.push(point(45.905, 6.873, "interrupted"));
    advance(1000);
    const [line, interrupted] = parse(track.frame().track).features;
    expect(line?.properties.kind).toBe("track");
    expect((line?.geometry.coordinates as unknown[]).length).toBe(6);
    expect(interrupted?.properties.kind).toBe("interrupted");
    expect(interrupted?.geometry).toEqual({
      type: "MultiLineString",
      coordinates: [
        [[6.87, 45.901], [6.871, 45.902], [6.872, 45.903]],
        [[6.872, 45.904], [6.873, 45.905]],
      ],
    });
  });

  it("draws the position with its accuracy in pixels at zoom 0 and its course", () => {
    const track = new LiveTrack(now);
    track.locate({ latitude: 60, longitude: 10, accuracyMeters: 10, bearingDegrees: 271.26 });
    const position = parse(track.frame().points).features.find((feature) => feature.properties.kind === "position");
    expect(position?.geometry.coordinates).toEqual([10, 60]);
    expect(position?.properties.accuracy0).toBeCloseTo((10 * 512) / 40_075_016.686 / 0.5, 9);
    expect(position?.properties.bearing).toBe(271.3);
    expect(track.frame().position?.accuracyMeters).toBe(10);
  });

  it("stops notifying once disposed", () => {
    const track = new LiveTrack(now);
    const listener = vi.fn();
    track.subscribe(listener);
    track.push(point(45.9, 6.87));
    track.push(point(45.91, 6.87));
    track.dispose();
    advance(2000);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
