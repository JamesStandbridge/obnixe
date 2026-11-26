import type { DemTile, DemTileKey } from "@obnixe/core";
import { demTileSize } from "@obnixe/core";

/*
 * Contour lines of one DEM tile by marching squares (`MAP-006`). Every function runs as a worklet off the main thread,
 * so it only calls other worklets. The grid holds the elevation at pixel centers with one more column and row taken from
 * the east and south neighbours, so the lines of adjacent tiles meet.
 */

/** Grid points per side: a tile and the first column and row of its neighbours. */
export const contourGridSize = demTileSize + 1;

export interface ContourGridInput {
  readonly tile: DemTile;
  readonly east: DemTile | null;
  readonly south: DemTile | null;
  readonly southEast: DemTile | null;
}

/** The elevation grid of a tile; a missing neighbour repeats the tile's own edge, which leaves no line in that strip. */
export function contourGrid({ tile, east, south, southEast }: ContourGridInput): Float32Array {
  const size = contourGridSize;
  const last = demTileSize - 1;
  const grid = new Float32Array(size * size);
  for (let row = 0; row < demTileSize; row += 1) {
    grid.set(tile.elevation.subarray(row * demTileSize, (row + 1) * demTileSize), row * size);
    grid[row * size + demTileSize] = east === null ? (tile.elevation[row * demTileSize + last] ?? 0) : (east.elevation[row * demTileSize] ?? 0);
  }
  for (let column = 0; column < demTileSize; column += 1) {
    grid[demTileSize * size + column] = south === null ? (tile.elevation[last * demTileSize + column] ?? 0) : (south.elevation[column] ?? 0);
  }
  grid[size * size - 1] =
    southEast === null ? (grid[(demTileSize - 1) * size + demTileSize] ?? 0) : (southEast.elevation[0] ?? 0);
  return grid;
}

export interface ContourRequest {
  readonly key: DemTileKey;
  readonly interval: number;
  /** Every master contour is a multiple of this, and carries its elevation as a label. */
  readonly masterInterval: number;
}

/** Grid points kept within this distance of the drawn line, in DEM pixels. */
const simplifyTolerance = 0.3;

function crossing(grid: Float32Array, size: number, edge: number, level: number, out: Float64Array): void {
  "worklet";
  const cell = edge >> 1;
  const x = cell % size;
  const y = (cell - x) / size;
  const from = grid[cell] ?? 0;
  const to = (edge & 1) === 0 ? (grid[cell + 1] ?? 0) : (grid[cell + size] ?? 0);
  const ratio = (level - from) / (to - from);
  out[0] = (edge & 1) === 0 ? x + ratio : x;
  out[1] = (edge & 1) === 0 ? y : y + ratio;
}

function simplified(points: number[], tolerance: number): number[] {
  "worklet";
  const count = points.length / 2;
  if (count < 3) return points;
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack = [0, count - 1];
  while (stack.length > 0) {
    const last = stack.pop() ?? 0;
    const first = stack.pop() ?? 0;
    const ax = points[first * 2] ?? 0;
    const ay = points[first * 2 + 1] ?? 0;
    const dx = (points[last * 2] ?? 0) - ax;
    const dy = (points[last * 2 + 1] ?? 0) - ay;
    const length = Math.hypot(dx, dy);
    let farthest = -1;
    let distance = tolerance;
    for (let index = first + 1; index < last; index += 1) {
      const px = (points[index * 2] ?? 0) - ax;
      const py = (points[index * 2 + 1] ?? 0) - ay;
      const offset = length === 0 ? Math.hypot(px, py) : Math.abs(px * dy - py * dx) / length;
      if (offset > distance) {
        distance = offset;
        farthest = index;
      }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    stack.push(first, farthest, farthest, last);
  }
  const result: number[] = [];
  for (let index = 0; index < count; index += 1) if (keep[index] === 1) result.push(points[index * 2] ?? 0, points[index * 2 + 1] ?? 0);
  return result;
}

function coordinates(points: number[], key: DemTileKey): string {
  "worklet";
  const world = demTileSize * 2 ** key.zoom;
  const parts: string[] = [];
  for (let index = 0; index < points.length; index += 2) {
    const x = key.x * demTileSize + (points[index] ?? 0) + 0.5;
    const y = key.y * demTileSize + (points[index + 1] ?? 0) + 0.5;
    const longitude = (x / world) * 360 - 180;
    const latitude = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / world))) * 180) / Math.PI;
    parts.push(`[${longitude.toFixed(6)},${latitude.toFixed(6)}]`);
  }
  return parts.join(",");
}

/**
 * The cell's segments for one level, as pairs of edge ids: the horizontal edge below grid point (x, y) is `2 * i`, the
 * vertical one `2 * i + 1`, where `i = y * size + x`. Saddles are split by the mean of the four corners.
 */
function cellSegments(grid: Float32Array, size: number, cell: number, level: number, out: number[]): void {
  "worklet";
  const topLeft = grid[cell] ?? 0;
  const topRight = grid[cell + 1] ?? 0;
  const bottomRight = grid[cell + size + 1] ?? 0;
  const bottomLeft = grid[cell + size] ?? 0;
  const index = (topLeft >= level ? 8 : 0) | (topRight >= level ? 4 : 0) | (bottomRight >= level ? 2 : 0) | (bottomLeft >= level ? 1 : 0);
  const top = cell * 2;
  const bottom = (cell + size) * 2;
  const left = cell * 2 + 1;
  const right = (cell + 1) * 2 + 1;
  const centerAbove = (topLeft + topRight + bottomRight + bottomLeft) / 4 >= level;
  switch (index) {
    case 1:
    case 14:
      out.push(left, bottom);
      return;
    case 2:
    case 13:
      out.push(bottom, right);
      return;
    case 3:
    case 12:
      out.push(left, right);
      return;
    case 4:
    case 11:
      out.push(top, right);
      return;
    case 6:
    case 9:
      out.push(top, bottom);
      return;
    case 7:
    case 8:
      out.push(top, left);
      return;
    case 5:
      if (centerAbove) out.push(top, left, bottom, right);
      else out.push(top, right, left, bottom);
      return;
    case 10:
      if (centerAbove) out.push(top, right, left, bottom);
      else out.push(top, left, bottom, right);
      return;
    default:
      return;
  }
}

/** The GeoJSON features of a tile's contour lines, joined by commas, with `ele` in meters and `master` set on master lines. */
export function contourFeatures(grid: Float32Array, size: number, request: ContourRequest): string {
  "worklet";
  const { interval, masterInterval } = request;
  const byLevel = new Map<number, number[]>();
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const cell = y * size + x;
      const a = grid[cell] ?? 0;
      const b = grid[cell + 1] ?? 0;
      const c = grid[cell + size] ?? 0;
      const d = grid[cell + size + 1] ?? 0;
      const low = Math.min(a, b, c, d);
      const high = Math.max(a, b, c, d);
      for (let step = Math.max(1, Math.floor(low / interval) + 1); step * interval <= high; step += 1) {
        let segments = byLevel.get(step);
        if (segments === undefined) {
          segments = [];
          byLevel.set(step, segments);
        }
        cellSegments(grid, size, cell, step * interval, segments);
      }
    }
  }
  const first = new Int32Array(size * size * 2).fill(-1);
  const second = new Int32Array(size * size * 2).fill(-1);
  const visited = new Uint8Array(size * size * 2);
  const point = new Float64Array(2);
  const features: string[] = [];
  for (const [step, segments] of byLevel) {
    const level = step * interval;
    for (let index = 0; index < segments.length; index += 2) {
      const from = segments[index] ?? 0;
      const to = segments[index + 1] ?? 0;
      if (first[from] === -1) first[from] = to;
      else second[from] = to;
      if (first[to] === -1) first[to] = from;
      else second[to] = from;
    }
    const walk = (start: number): void => {
      const points: number[] = [];
      let previous = -1;
      let current = start;
      while (current !== -1 && visited[current] === 0) {
        visited[current] = 1;
        crossing(grid, size, current, level, point);
        points.push(point[0] ?? 0, point[1] ?? 0);
        const next = first[current] === previous ? (second[current] ?? -1) : (first[current] ?? -1);
        previous = current;
        current = next;
      }
      if (current === start) points.push(points[0] ?? 0, points[1] ?? 0);
      const line = simplified(points, simplifyTolerance);
      if (line.length < 4) return;
      const master = level % masterInterval === 0;
      features.push(
        `{"type":"Feature","properties":{"ele":${level},"master":${master}},"geometry":{"type":"LineString","coordinates":[${coordinates(line, request.key)}]}}`,
      );
    };
    for (let index = 0; index < segments.length; index += 1) {
      const edge = segments[index] ?? 0;
      if (visited[edge] === 0 && second[edge] === -1) walk(edge);
    }
    for (let index = 0; index < segments.length; index += 1) {
      const edge = segments[index] ?? 0;
      if (visited[edge] === 0) walk(edge);
    }
    for (let index = 0; index < segments.length; index += 1) {
      const edge = segments[index] ?? 0;
      first[edge] = -1;
      second[edge] = -1;
      visited[edge] = 0;
    }
  }
  return features.join(",");
}
