import { decodeTerrarium, demTileName, DemTiles, PngDecodeError } from "@obnixe/core";
import type { DemTile, DemTileKey } from "@obnixe/core";
import { cacheDemBytes, cachedDemBytes, forgetDemBytes } from "@/features/maps/demStore";
import { demTileUrl } from "@/features/maps/styles";

const requestTimeoutMs = 15_000;
const parallelRequests = 6;
/** Decoded tiles kept in memory, 256 KiB each. */
const decodedLimit = 48;

const decoded = new Map<string, DemTile>();
const pending = new Map<string, Promise<DemTile | null>>();

/** `fetch` rejects with a `TypeError` when the network fails and with an `AbortError` when its signal fires. */
function isTransportError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

async function download(key: DemTileKey): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(demTileUrl(key), { signal: controller.signal });
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (isTransportError(error)) return null;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function decode(key: DemTileKey, bytes: Uint8Array): DemTile | null {
  try {
    return decodeTerrarium(key, bytes);
  } catch (error) {
    if (error instanceof PngDecodeError) return null;
    throw error;
  }
}

async function load(key: DemTileKey): Promise<DemTile | null> {
  const cached = await cachedDemBytes(key);
  if (cached !== null) {
    const tile = decode(key, cached);
    if (tile !== null) return tile;
    forgetDemBytes(key);
  }
  const bytes = await download(key);
  if (bytes === null) return null;
  const tile = decode(key, bytes);
  if (tile !== null) await cacheDemBytes(key, bytes);
  return tile;
}

function remember(name: string, tile: DemTile): void {
  decoded.delete(name);
  decoded.set(name, tile);
  if (decoded.size <= decodedLimit) return;
  const oldest = decoded.keys().next();
  if (oldest.done !== true) decoded.delete(oldest.value);
}

/** A Terrain Tiles tile from memory, the file cache or the network; null when offline or unreadable. */
export function demTile(key: DemTileKey): Promise<DemTile | null> {
  const name = demTileName(key);
  const known = decoded.get(name);
  if (known !== undefined) {
    remember(name, known);
    return Promise.resolve(known);
  }
  const running = pending.get(name);
  if (running !== undefined) return running;
  const loading = load(key)
    .then((tile) => {
      if (tile !== null) remember(name, tile);
      return tile;
    })
    .finally(() => pending.delete(name));
  pending.set(name, loading);
  return loading;
}

/** The tiles in order, a few requests at a time; null for those that cannot be had. */
export async function demTilesOf(keys: readonly DemTileKey[]): Promise<readonly (DemTile | null)[]> {
  const tiles: (DemTile | null)[] = new Array<DemTile | null>(keys.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < keys.length) {
      const index = next;
      next += 1;
      const key = keys[index];
      if (key !== undefined) tiles[index] = await demTile(key);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallelRequests, keys.length) }, worker));
  return tiles;
}

/** Every tile a DEM correction needs (`ELE-003`), or null when one is missing. */
export async function loadDemTiles(zoom: number, keys: readonly DemTileKey[]): Promise<DemTiles | null> {
  const tiles = await demTilesOf(keys);
  const present = tiles.filter((tile): tile is DemTile => tile !== null);
  return present.length === keys.length ? new DemTiles(zoom, present) : null;
}
