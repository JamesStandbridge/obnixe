import type { DemTileKey } from "@obnixe/core";

/** The browser's HTTP cache keeps the Terrain Tiles on the web. */
export async function cachedDemBytes(_key: DemTileKey): Promise<Uint8Array | null> {
  return null;
}

export async function cacheDemBytes(_key: DemTileKey, _bytes: Uint8Array): Promise<void> {}

export function forgetDemBytes(_key: DemTileKey): void {}
