import { Directory, File, Paths } from "expo-file-system";
import { demTileName } from "@obnixe/core";
import type { DemTileKey } from "@obnixe/core";

/** Terrain Tiles kept in the cache directory, which the system may empty: a missing tile is downloaded again. */
const directory = (): Directory => new Directory(Paths.cache, "dem");

function fileOf(key: DemTileKey): File {
  return new File(directory(), `${demTileName(key).replaceAll("/", "-")}.png`);
}

export async function cachedDemBytes(key: DemTileKey): Promise<Uint8Array | null> {
  const file = fileOf(key);
  return file.exists ? file.bytes() : null;
}

export async function cacheDemBytes(key: DemTileKey, bytes: Uint8Array): Promise<void> {
  directory().create({ idempotent: true, intermediates: true });
  await fileOf(key).write(bytes);
}

export function forgetDemBytes(key: DemTileKey): void {
  const file = fileOf(key);
  if (file.exists) file.delete();
}
