import { eq } from "drizzle-orm";
import { zlibSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { recording } from "@obnixe/schema";
import type { EpochMs, Id } from "@obnixe/schema";
import { fixtures } from "../data/testFixtures.ts";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { revert } from "../undo.ts";
import { commit } from "../writer.ts";
import { processTrack } from "./batch.ts";
import { crc32 } from "./codec/crc32.ts";
import { decodePng, PngDecodeError } from "./codec/png.ts";
import { decodeTrack, encodeTrack, trackDigest } from "./codec/track.ts";
import type { Track } from "./codec/track.ts";
import { correctElevation, decodeTerrarium, demCorrectionZoom, DemTiles, demTileSize, demTilesFor, sampleTerrarium } from "./dem.ts";
import type { DemTile, DemTileKey } from "./dem.ts";
import { planElevationCorrection, planElevationRestore } from "./demRows.ts";
import { computeDemImport, computeImport, planImport } from "./io/import.ts";
import { readActivityFile } from "./io/zip.ts";
import { planRecordingSave, planRecordingStart, recordingStartMutations } from "./plans.ts";
import { demRoutePath, measureRoutePath, routePathOf } from "./routes.ts";
import { coreScenarios, mountainOuting } from "./testing/scenarios.ts";
import type { Scenario } from "./testing/scenarios.ts";
import { profileOf, recordedLaps, trackOf, untrimmed } from "./testing/run.ts";
import { noTerrain } from "./types.ts";
import type { TerrainColumns } from "./types.ts";

const user = { author: "user", connectionId: null } as const;

function chunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  view.setUint32(8 + data.length, crc32(bytes, 4, 8 + data.length));
  return bytes;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** A PNG whose row `r` uses the filter `r % 5`, so that decoding covers all five. */
function encodePng(width: number, height: number, channels: 3 | 4, pixels: Uint8Array): Uint8Array {
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  for (let row = 0; row < height; row += 1) {
    const filter = row % 5;
    raw[row * (stride + 1)] = filter;
    for (let column = 0; column < stride; column += 1) {
      const value = pixels[row * stride + column] ?? 0;
      const left = column >= channels ? (pixels[row * stride + column - channels] ?? 0) : 0;
      const up = row > 0 ? (pixels[(row - 1) * stride + column] ?? 0) : 0;
      const upLeft = row > 0 && column >= channels ? (pixels[(row - 1) * stride + column - channels] ?? 0) : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter] ?? 0;
      raw[row * (stride + 1) + 1 + column] = (value - predicted) & 0xff;
    }
  }
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, channels === 3 ? 2 : 6, 0, 0, 0], 8);
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array(0))];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** World pixel coordinates of a point, from the pixel centres: the plane below is exact under bilinear interpolation. */
function worldPixels(latitude: number, longitude: number, zoom: number): { readonly x: number; readonly y: number } {
  const size = demTileSize * 2 ** zoom;
  const sine = Math.sin((latitude * Math.PI) / 180);
  return { x: ((longitude + 180) / 360) * size - 0.5, y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * size - 0.5 };
}

const plane = (x: number, y: number): number => 1000 + 0.02 * (x % 100_000) - 0.05 * (y % 100_000);

function planeTile(key: DemTileKey): DemTile {
  const elevation = new Float32Array(demTileSize * demTileSize);
  for (let row = 0; row < demTileSize; row += 1) {
    for (let column = 0; column < demTileSize; column += 1) elevation[row * demTileSize + column] = plane(key.x * demTileSize + column, key.y * demTileSize + row);
  }
  return { key, elevation };
}

const grenoble = { latitude: 45.1885, longitude: 5.7245 };

/** Terrain under every fix of a scenario from its true altitude, optionally reshaped by distance along the truth. */
function truthTerrain(scenario: Scenario, track: Track, reshape: (meters: number, altitude: number) => number = (_, altitude) => altitude): TerrainColumns {
  const { truth } = scenario;
  const meters = new Float64Array(truth.length);
  for (let index = 1; index < truth.length; index += 1) meters[index] = (meters[index - 1] ?? 0) + ((truth.speed[index] ?? 0) * ((truth.t[index] ?? 0) - (truth.t[index - 1] ?? 0))) / 1000;
  const byTime = new Map<number, number>();
  truth.t.forEach((t, index) => byTime.set(t, index));
  const { fixes } = track.samples;
  return {
    length: fixes.length,
    t: fixes.t.slice(),
    altitudeMm: Int32Array.from(fixes.t, (t) => {
      const index = byTime.get(t) ?? 0;
      return Math.round(reshape(meters[index] ?? 0, truth.altitude[index] ?? 0) * 1000);
    }),
  };
}

function corrected(scenario: Scenario, reshape?: (meters: number, altitude: number) => number) {
  const track = trackOf(scenario.samples, [{ kind: "start", t: 0 }]);
  const withTerrain: Track = { ...track, samples: { ...track.samples, terrain: truthTerrain(scenario, track, reshape) } };
  return processTrack(withTerrain, profileOf(scenario), { laps: recordedLaps, trim: untrimmed });
}

describe("PNG tiles", () => {
  it("decodes every row filter of RGB and RGBA images", () => {
    for (const channels of [3, 4] as const) {
      const pixels = Uint8Array.from({ length: 7 * 6 * channels }, (_, index) => (index * 37 + (index >> 3) * 11) & 0xff);
      expect(decodePng(encodePng(7, 6, channels, pixels))).toEqual({ width: 7, height: 6, channels, pixels });
    }
  });

  it("refuses a damaged or unsupported file", () => {
    const valid = encodePng(2, 2, 3, new Uint8Array(12));
    expect(() => decodePng(valid.slice(1))).toThrow(PngDecodeError);
    const damaged = valid.slice();
    damaged[40] = (damaged[40] ?? 0) ^ 0xff;
    expect(() => decodePng(damaged)).toThrow(PngDecodeError);
    const sixteenBits = valid.slice();
    sixteenBits[24] = 16;
    new DataView(sixteenBits.buffer).setUint32(29, crc32(sixteenBits, 12, 29));
    expect(() => decodePng(sixteenBits)).toThrow("only 8-bit");
  });
});

describe("DEM sampling (ELE-003)", () => {
  it("decodes Terrarium altitudes and refuses a tile of another size", () => {
    const pixels = new Uint8Array(demTileSize * demTileSize * 3);
    pixels.set([128, 0, 0, 130, 10, 128, 127, 255, 0]);
    const tile = decodeTerrarium({ zoom: 13, x: 0, y: 0 }, encodePng(demTileSize, demTileSize, 3, pixels));
    expect(Array.from(tile.elevation.subarray(0, 3))).toEqual([0, 522.5, -1]);
    expect(() => decodeTerrarium({ zoom: 13, x: 0, y: 0 }, encodePng(16, 16, 3, new Uint8Array(768)))).toThrow(PngDecodeError);
  });

  it("interpolates bilinearly between pixel centres, across tile edges, and needs every tile around a point", () => {
    const tileX = Math.floor(((grenoble.longitude + 180) / 360) * 2 ** demCorrectionZoom);
    const edgeLongitude = ((tileX + 1) / 2 ** demCorrectionZoom) * 360 - 180 - 1e-6;
    const points = [grenoble, { latitude: grenoble.latitude, longitude: edgeLongitude }];
    const keys = demTilesFor(
      points.map((point) => point.latitude * 1e7),
      points.map((point) => point.longitude * 1e7),
      demCorrectionZoom,
    );
    expect(keys.length).toBeGreaterThanOrEqual(2);
    const tiles = new DemTiles(demCorrectionZoom, keys.map(planeTile));
    for (const point of points) {
      const { x, y } = worldPixels(point.latitude, point.longitude, demCorrectionZoom);
      expect(tiles.altitudeAt(point.latitude, point.longitude)).toBeCloseTo(plane(x, y), 3);
    }
    const partial = new DemTiles(
      demCorrectionZoom,
      keys.filter((key) => key.x === tileX).map(planeTile),
    );
    expect(partial.altitudeAt(grenoble.latitude, edgeLongitude)).toBeNull();
  });

  it("samples one altitude per fix time, or nothing when a tile is missing", () => {
    const track = trackOf(coreScenarios.steadyRun(1).samples);
    const { fixes } = track.samples;
    const tiles = new DemTiles(demCorrectionZoom, demTilesFor(fixes.latitudeE7, fixes.longitudeE7, demCorrectionZoom).map(planeTile));
    const terrain = sampleTerrarium(fixes, tiles);
    expect(terrain?.length).toBe(new Set(fixes.t).size);
    const { x, y } = worldPixels((fixes.latitudeE7[10] ?? 0) / 1e7, (fixes.longitudeE7[10] ?? 0) / 1e7, demCorrectionZoom);
    expect((terrain?.altitudeMm[10] ?? 0) / 1000).toBeCloseTo(plane(x, y), 2);
    expect(sampleTerrarium(fixes, new DemTiles(demCorrectionZoom, []))).toBeNull();
  });

  it("keeps the recorded altitude on a bridge or in a tunnel, shifted by the offset around it", () => {
    const distance = Float64Array.from({ length: 301 }, (_, index) => index * 10);
    const recorded = Float64Array.from(distance, (meters) => 500 + 0.05 * meters);
    const terrain = Float64Array.from(distance, (meters, index) => (recorded[index] ?? 0) + 3 - (meters > 1000 && meters < 1100 ? 40 : 0) - (meters > 1500 && meters < 2200 ? 30 : 0));
    recorded[2900 / 10] = Number.NaN;
    const result = correctElevation(recorded, terrain, distance);
    expect(result[50]).toBeCloseTo((recorded[50] ?? 0) + 3, 9);
    expect(result[105]).toBeCloseTo((recorded[105] ?? 0) + 3, 9);
    expect(result[180]).toBeCloseTo(terrain[180] ?? 0, 9);
    expect(result[290]).toBe(terrain[290]);
  });

  it("measures a corrected track on the DEM with a 3 m threshold, barometer or not", () => {
    for (const scenario of [coreScenarios.forestCanopy(3), mountainOuting(1, 4)]) {
      const processed = corrected(scenario);
      expect(processed.summary.elevationSource).toBe("dem");
      expect(Math.abs((processed.summary.ascentMm ?? 0) / 1000 - scenario.truth.ascent)).toBeLessThanOrEqual(0.08 * scenario.truth.ascent);
    }
  });

  it("does not count the valley under a 150 m bridge, but follows a dip of 600 m", () => {
    const flat = coreScenarios.steadyRun(5);
    const dip = (from: number, length: number) => (meters: number, altitude: number) => altitude - (meters > from && meters < from + length ? 40 : 0);
    expect((corrected(flat, dip(3000, 150)).summary.ascentMm ?? 0) / 1000).toBeLessThan(10);
    expect((corrected(flat, dip(3000, 600)).summary.ascentMm ?? 0) / 1000).toBeGreaterThan(35);
  });
});

describe("DEM correction rows (ELE-003)", () => {
  let context: TestContext;
  const startedAt = Date.UTC(2026, 10, 20, 8, 0) as EpochMs;

  beforeEach(() => {
    context = createTestContext();
    fixtures(context);
  });

  const recordingOf = (sessionId: Id) => context.db.select().from(recording).where(eq(recording.sessionId, sessionId)).get();

  function recordOuting(scenario: Scenario): { readonly sessionId: Id; readonly track: Track } {
    const track: Track = { ...trackOf(scenario.samples, [{ kind: "start", t: 0 }]), startedAt };
    const plan = planRecordingStart(context.db, context.env, { sport: scenario.sport, values: {}, gearId: null, slot: null, timeZone: "Europe/Paris", routeId: null, workout: null, stopwatch: false });
    commit(context.db, context.env, { actor: user, summary: "Sortie démarrée", revertsId: null, mutations: recordingStartMutations(plan, { startedAt, device: "Pixel 9 Pro" }) });
    const processed = processTrack(track, profileOf(scenario), { laps: recordedLaps, trim: untrimmed });
    const bytes = encodeTrack(track);
    const mutations = planRecordingSave(context.db, context.env, { sessionId: plan.sessionId, track, processed, stored: { file: `tracks/${plan.recordingId}.otrk`, sha256: trackDigest(bytes), bytes: bytes.length }, pains: [] });
    commit(context.db, context.env, { actor: user, summary: "Sortie", revertsId: null, mutations });
    return { sessionId: plan.sessionId, track };
  }

  it("moves a recording onto a new file with the DEM altitude, undoably, and restores the recorded altitude", () => {
    const scenario = coreScenarios.forestCanopy(7);
    const { sessionId, track } = recordOuting(scenario);
    const before = recordingOf(sessionId);
    expect(before?.elevationSource).toBe("gnss");
    const plan = planElevationCorrection(context.db, context.env, sessionId, track, truthTerrain(scenario, track));
    expect(decodeTrack(plan.file.bytes).samples.fixes).toEqual(track.samples.fixes);
    const changesetId = commit(context.db, context.env, { actor: user, summary: "Altitude corrigée", revertsId: null, mutations: plan.rewrite.mutations });
    const after = recordingOf(sessionId);
    expect(after).toMatchObject({ id: plan.recordingId, elevationSource: "dem", trackFile: plan.file.path, trackSha256: plan.file.sha256 });
    expect(Math.abs((after?.ascentMm ?? 0) / 1000 - scenario.truth.ascent)).toBeLessThan(Math.abs((before?.ascentMm ?? 0) / 1000 - scenario.truth.ascent));

    revert(context.db, context.env, { actor: user, changesetId, summary: "Annulation", restoredVersionSummary: (number) => `v${number}` });
    expect(recordingOf(sessionId)).toMatchObject({ id: before?.id, elevationSource: "gnss", ascentMm: before?.ascentMm });

    commit(context.db, context.env, { actor: user, summary: "Altitude corrigée", revertsId: null, mutations: plan.rewrite.mutations });
    const restore = planElevationRestore(context.db, context.env, sessionId, decodeTrack(plan.file.bytes));
    expect(decodeTrack(restore.file.bytes).samples.terrain.length).toBe(0);
    commit(context.db, context.env, { actor: user, summary: "Altitude d'origine", revertsId: null, mutations: restore.rewrite.mutations });
    expect(recordingOf(sessionId)).toMatchObject({ elevationSource: "gnss", ascentMm: before?.ascentMm });
  });

  it("measures an import without altitude on the DEM before writing it, and restores it without altitude", () => {
    const scenario = coreScenarios.forestCanopy(8);
    const points = scenario.samples.flatMap((sample) =>
      sample.type === "fix" ? [`<trkpt lat="${(sample.latitudeE7 / 1e7).toFixed(7)}" lon="${(sample.longitudeE7 / 1e7).toFixed(7)}"><time>${new Date(startedAt + sample.t).toISOString()}</time></trkpt>`] : [],
    );
    const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><type>hiking</type><trkseg>${points.join("")}</trkseg></trk></gpx>`;
    const plain = computeImport(readActivityFile(new TextEncoder().encode(gpx)), { sport: "trail", values: {} });
    expect(plain.summary.elevationSource).toBe("none");
    const fixes = plain.track.samples.fixes;
    const shifted = { ...scenario, truth: { ...scenario.truth, t: Float64Array.from(scenario.truth.t, (t) => t + (fixes.t[0] ?? 0) - (scenario.truth.t[0] ?? 0)) } };
    const dem = computeDemImport(plain, truthTerrain(shifted, plain.track));
    expect(dem.summary.elevationSource).toBe("dem");
    expect((dem.summary.ascentMm ?? 0) / 1000).toBeGreaterThan(0.8 * scenario.truth.ascent);
    const plan = planImport(context.db, context.env, { computation: dem, timeZone: "Europe/Paris", replaceSessionId: null });
    commit(context.db, context.env, plan.request);
    expect(recordingOf(plan.sessionId)?.elevationSource).toBe("dem");
    const restore = planElevationRestore(context.db, context.env, plan.sessionId, decodeTrack(plan.track?.bytes ?? new Uint8Array(0)));
    commit(context.db, context.env, { actor: user, summary: "Altitude d'origine", revertsId: null, mutations: restore.rewrite.mutations });
    expect(recordingOf(plan.sessionId)).toMatchObject({ elevationSource: "none", ascentMm: null });
    expect(computeDemImport(plain, noTerrain).summary).toEqual(plain.summary);
  });
});

describe("DEM routes (ELE-003)", () => {
  it("gives a route without altitude the DEM altitude of its points, measured with the DEM threshold", () => {
    const points = Array.from({ length: 200 }, (_, index) => ({ latitudeE7: Math.round((grenoble.latitude + index * 0.0002) * 1e7), longitudeE7: Math.round(grenoble.longitude * 1e7), altitudeMm: null }));
    const path = routePathOf(points);
    expect(measureRoutePath(path, "file").elevationSource).toBe("none");
    const tiles = new DemTiles(demCorrectionZoom, demTilesFor(path.latitudeE7, path.longitudeE7, demCorrectionZoom).map(planeTile));
    const dem = demRoutePath(path, tiles);
    if (dem === null) throw new Error("Missing tile");
    const first = worldPixels(grenoble.latitude, grenoble.longitude, demCorrectionZoom);
    expect((dem.altitudeMm[0] ?? 0) / 1000).toBeCloseTo(plane(first.x, first.y), 2);
    const measure = measureRoutePath(dem, "dem");
    expect(measure.elevationSource).toBe("dem");
    const rise = ((dem.altitudeMm[path.length - 1] ?? 0) - (dem.altitudeMm[0] ?? 0)) / 1000;
    expect(Math.abs((measure.ascentMm ?? 0) / 1000 - Math.max(rise, 0))).toBeLessThan(1);
    expect(demRoutePath(path, new DemTiles(demCorrectionZoom, []))).toBeNull();
  });
});
