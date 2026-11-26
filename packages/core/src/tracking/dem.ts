import { decodePng, PngDecodeError } from "./codec/png.ts";
import type { FixColumns, TerrainColumns } from "./types.ts";

/*
 * DEM sampled on the device (`ELE-003`, `Q-20`): Terrain Tiles in Terrarium encoding, read with bilinear interpolation
 * between pixel centres. Only tiles are requested, like for a map; no position leaves the phone.
 */

export const demTileSize = 256;
/** `ELE-003`: about 13 m per pixel at 45° of latitude. */
export const demCorrectionZoom = 13;
/** A shorter stretch where the DEM and the recorded altitude differ by more than `demStructureGapMeters` is a bridge or a tunnel. */
export const demStructureMaxMeters = 300;
export const demStructureGapMeters = 15;

const maxLatitude = 85.051129;

export interface DemTileKey {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

/** Altitudes in meters of the 256 × 256 pixels of a tile, row after row from the north-west corner. */
export interface DemTile {
  readonly key: DemTileKey;
  readonly elevation: Float32Array;
}

export function demTileName({ zoom, x, y }: DemTileKey): string {
  return `${zoom}/${x}/${y}`;
}

/** Decodes a Terrarium tile: altitude = R × 256 + G + B / 256 − 32768. */
export function decodeTerrarium(key: DemTileKey, bytes: Uint8Array): DemTile {
  const image = decodePng(bytes);
  if (image.width !== demTileSize || image.height !== demTileSize) throw new PngDecodeError(`tile ${demTileName(key)} is ${image.width} × ${image.height} px`);
  const elevation = new Float32Array(demTileSize * demTileSize);
  for (let index = 0; index < elevation.length; index += 1) {
    const offset = index * image.channels;
    elevation[index] = (image.pixels[offset] ?? 0) * 256 + (image.pixels[offset + 1] ?? 0) + (image.pixels[offset + 2] ?? 0) / 256 - 32768;
  }
  return { key, elevation };
}

/** The pixel centre at the north-west of a point, in world pixels at a zoom, and the point's offset from it. */
interface PixelCell {
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
}

function cellOf(latitude: number, longitude: number, zoom: number): PixelCell {
  const size = demTileSize * 2 ** zoom;
  const sine = Math.sin((Math.max(-maxLatitude, Math.min(maxLatitude, latitude)) * Math.PI) / 180);
  const px = ((longitude + 180) / 360) * size - 0.5;
  const py = (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * size - 0.5;
  const x = Math.floor(px);
  const y = Math.floor(py);
  return { x, y, dx: px - x, dy: py - y };
}

/** World pixel `(x, y)` wrapped around the antimeridian and clamped at the poles. */
interface WorldPixel {
  readonly tileX: number;
  readonly tileY: number;
  readonly index: number;
}

function worldPixel(x: number, y: number, zoom: number): WorldPixel {
  const size = demTileSize * 2 ** zoom;
  const wrapped = ((x % size) + size) % size;
  const clamped = Math.max(0, Math.min(size - 1, y));
  return { tileX: Math.floor(wrapped / demTileSize), tileY: Math.floor(clamped / demTileSize), index: (clamped % demTileSize) * demTileSize + (wrapped % demTileSize) };
}

const tileNumber = (tileX: number, tileY: number, zoom: number): number => tileX * 2 ** zoom + tileY;

/** The tiles holding the four pixels around each point (coordinates in 1e-7 degrees), so that every point can be interpolated. */
export function demTilesFor(latitudeE7: ArrayLike<number>, longitudeE7: ArrayLike<number>, zoom: number): readonly DemTileKey[] {
  const keys = new Map<number, DemTileKey>();
  for (let index = 0; index < latitudeE7.length; index += 1) {
    const cell = cellOf((latitudeE7[index] ?? 0) / 1e7, (longitudeE7[index] ?? 0) / 1e7, zoom);
    for (const [ox, oy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const pixel = worldPixel(cell.x + ox, cell.y + oy, zoom);
      const number = tileNumber(pixel.tileX, pixel.tileY, zoom);
      if (!keys.has(number)) keys.set(number, { zoom, x: pixel.tileX, y: pixel.tileY });
    }
  }
  return [...keys.values()];
}

/** Decoded tiles of one zoom, read by position. */
export class DemTiles {
  private readonly elevations = new Map<number, Float32Array>();

  constructor(
    readonly zoom: number,
    tiles: readonly DemTile[],
  ) {
    for (const tile of tiles) if (tile.key.zoom === zoom) this.elevations.set(tileNumber(tile.key.x, tile.key.y, zoom), tile.elevation);
  }

  private pixel(x: number, y: number): number {
    const at = worldPixel(x, y, this.zoom);
    return this.elevations.get(tileNumber(at.tileX, at.tileY, this.zoom))?.[at.index] ?? Number.NaN;
  }

  /** Altitude in meters, bilinear between the four pixel centres around the point; `null` when one of their tiles is missing. */
  altitudeAt(latitude: number, longitude: number): number | null {
    const { x, y, dx, dy } = cellOf(latitude, longitude, this.zoom);
    const top = this.pixel(x, y) * (1 - dx) + this.pixel(x + 1, y) * dx;
    const bottom = this.pixel(x, y + 1) * (1 - dx) + this.pixel(x + 1, y + 1) * dx;
    const value = top * (1 - dy) + bottom * dy;
    return Number.isNaN(value) ? null : value;
  }
}

/** The DEM altitude under each fix, one entry per fix time; `null` when a tile is missing. */
export function sampleTerrarium(fixes: FixColumns, tiles: DemTiles): TerrainColumns | null {
  const t: number[] = [];
  const altitudeMm: number[] = [];
  for (let index = 0; index < fixes.length; index += 1) {
    const time = fixes.t[index] ?? 0;
    if (t.length > 0 && t[t.length - 1] === time) continue;
    const altitude = tiles.altitudeAt((fixes.latitudeE7[index] ?? 0) / 1e7, (fixes.longitudeE7[index] ?? 0) / 1e7);
    if (altitude === null) return null;
    t.push(time);
    altitudeMm.push(Math.round(altitude * 1000));
  }
  return { length: t.length, t: Uint32Array.from(t), altitudeMm: Int32Array.from(altitudeMm) };
}

/**
 * The DEM altitude, except on bridges and in tunnels (`ELE-003`): where the DEM and the recorded altitude differ by more
 * than 15 m for less than 300 m, the recorded altitude is kept over that stretch and the slopes of the gap around it,
 * shifted by the DEM offset found on either side so the profile stays continuous. Without a recorded altitude the DEM is taken as it is; `NaN` marks unknown values.
 */
export function correctElevation(recorded: Float64Array, terrain: Float64Array, distance: Float64Array): Float64Array {
  const { length } = terrain;
  const corrected = new Float64Array(length);
  const gap = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const dem = terrain[index] ?? Number.NaN;
    corrected[index] = Number.isNaN(dem) ? (recorded[index] ?? Number.NaN) : dem;
    gap[index] = dem - (recorded[index] ?? Number.NaN);
  }
  const departs = (index: number): boolean => Math.abs(gap[index] ?? Number.NaN) > demStructureGapMeters;
  const known = (index: number): boolean => index >= 0 && index < length && !Number.isNaN(gap[index] ?? Number.NaN);
  let start = 0;
  while (start < length) {
    if (!departs(start)) {
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < length && departs(end + 1)) end += 1;
    if ((distance[end] ?? 0) - (distance[start] ?? 0) < demStructureMaxMeters) {
      let before = known(start - 1) ? start - 1 : null;
      while (before !== null && known(before - 1) && Math.abs(gap[before - 1] ?? 0) < Math.abs(gap[before] ?? 0)) before -= 1;
      let after = known(end + 1) ? end + 1 : null;
      while (after !== null && known(after + 1) && Math.abs(gap[after + 1] ?? 0) < Math.abs(gap[after] ?? 0)) after += 1;
      if (before !== null) start = before + 1;
      if (after !== null) end = after - 1;
      const from = before === null ? (after === null ? 0 : (gap[after] ?? 0)) : (gap[before] ?? 0);
      const to = after === null ? from : (gap[after] ?? 0);
      const fromDistance = distance[before ?? start] ?? 0;
      const span = (distance[after ?? end] ?? 0) - fromDistance;
      for (let index = start; index <= end; index += 1) {
        const ratio = span > 0 ? ((distance[index] ?? 0) - fromDistance) / span : 0;
        corrected[index] = (recorded[index] ?? 0) + from + (to - from) * ratio;
      }
    }
    start = end + 1;
  }
  return corrected;
}
