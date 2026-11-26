import { afterEach, describe, expect, it, vi } from "vitest";
import { zlibSync } from "fflate";
import { demTileSize } from "@obnixe/core";
import type { FixColumns } from "@obnixe/core";
import { terrainUnder } from "@/features/maps/terrain";
import { candidateFigures, readRoute, routeProfilePoints, withDem } from "@/features/routes/routeData";
import type { RouteCandidate } from "@/features/routes/routeData";

const encoder = new TextEncoder();
const metersPerDegree = 111_195;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  body.set(encoder.encode(type));
  body.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return out;
}

/** A Terrarium tile whose elevation falls 0.5 m per DEM pixel southward, continuous across tiles. */
function terrariumTile(y: number): Uint8Array<ArrayBuffer> {
  const raw = new Uint8Array(demTileSize * (1 + demTileSize * 3));
  for (let row = 0; row < demTileSize; row += 1) {
    const value = Math.round((5000 - (y * demTileSize + row - 745_000) * 0.5 + 32768) * 256);
    for (let column = 0; column < demTileSize; column += 1) {
      const at = row * (1 + demTileSize * 3) + 1 + column * 3;
      raw[at] = (value >> 16) & 0xff;
      raw[at + 1] = (value >> 8) & 0xff;
      raw[at + 2] = value & 0xff;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, demTileSize);
  view.setUint32(4, demTileSize);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array<ArrayBuffer>(new ArrayBuffer(parts.reduce((sum, part) => sum + part.length, 0)));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function serveTerrain(): ReturnType<typeof vi.fn> {
  const served = vi.fn(async (url: string) => {
    const match = /terrarium\/\d+\/\d+\/(\d+)\.png$/.exec(url);
    if (match === null) return new Response(null, { status: 404 });
    return new Response(terrariumTile(Number(match[1])), { status: 200 });
  });
  vi.stubGlobal("fetch", served);
  return served;
}

/** A GPX `rte` going north from `latitude`, one point every 100 m, without altitude. */
function flatRoute(latitude: number, points: number): RouteCandidate {
  const rtepts = Array.from({ length: points }, (_, index) => `<rtept lat="${(latitude + (index * 100) / metersPerDegree).toFixed(7)}" lon="5.7245000"></rtept>`);
  const reading = readRoute(encoder.encode(`<?xml version="1.0"?><gpx version="1.1" creator="test"><rte><name>Sans altitude</name>${rtepts.join("")}</rte></gpx>`));
  if (reading.kind !== "read") throw new Error(reading.message);
  return reading.candidate;
}

function fixesAt(latitudes: readonly number[]): FixColumns {
  const length = latitudes.length;
  const filled = (value: number): Int32Array => new Int32Array(length).fill(value);
  return {
    length,
    t: Uint32Array.from(latitudes, (_, index) => index * 1000),
    fixAgeMs: filled(0),
    latitudeE7: Int32Array.from(latitudes, (latitude) => Math.round(latitude * 1e7)),
    longitudeE7: filled(57_245_000),
    altitudeEllipsoidMm: filled(1_000_000),
    altitudeMslMm: filled(950_000),
    horizontalAccuracyDm: filled(50),
    verticalAccuracyDm: filled(80),
    speedCmS: filled(300),
    speedAccuracyCmS: filled(50),
    bearingCentiDeg: filled(0),
    bearingAccuracyCentiDeg: filled(1000),
    simulated: new Uint8Array(length),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DEM on the phone (ELE-003)", () => {
  it("leaves a route without altitude as it is when the relief cannot be downloaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Network request failed");
      }),
    );
    const candidate = flatRoute(44.5, 31);
    expect(await withDem(candidate)).toBe(candidate);
    expect(await terrainUnder(fixesAt([44.5, 44.501]))).toBeNull();
  });

  it("measures the D+ and the profile of a route without altitude on the DEM (RTE-001)", async () => {
    serveTerrain();
    const candidate = flatRoute(45.1885, 31);
    expect(candidate.elevationSource).toBe("none");
    const measured = await withDem(candidate);
    expect(measured.elevationSource).toBe("dem");
    const ascent = (candidateFigures(measured.geometry).ascentMm ?? 0) / 1000;
    expect(ascent).toBeGreaterThan(90);
    expect(ascent).toBeLessThan(130);
    expect(routeProfilePoints(measured.geometry).length).toBeGreaterThan(2);
  });

  it("samples the DEM under fixes once per tile, then from memory", async () => {
    const served = serveTerrain();
    const fixes = fixesAt([46.2, 46.2005, 46.201]);
    const terrain = await terrainUnder(fixes);
    expect(terrain?.length).toBe(3);
    expect((terrain?.altitudeMm[0] ?? 0) / 1000).toBeLessThan((terrain?.altitudeMm[2] ?? 0) / 1000);
    const requests = served.mock.calls.length;
    expect(requests).toBeGreaterThan(0);
    await terrainUnder(fixes);
    expect(served.mock.calls.length).toBe(requests);
  });
});
