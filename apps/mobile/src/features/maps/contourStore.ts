import { Directory, File, Paths } from "expo-file-system";

/** `contours/`: traced tiles in the cache directory, capped at 50 MB, the oldest written leaving first (`MAP-006`). */
const limitBytes = 50 * 1024 * 1024;
const extension = ".json";

const directory = (): Directory => new Directory(Paths.cache, "contours");

export async function storedContours(name: string): Promise<string | null> {
  const file = new File(directory(), `${name}${extension}`);
  return file.exists ? file.text() : null;
}

export async function storeContours(name: string, features: string): Promise<void> {
  const folder = directory();
  folder.create({ idempotent: true, intermediates: true });
  await new File(folder, `${name}${extension}`).write(features);
}

/** Deletes the least recently written tiles beyond the cap. */
export function trimContours(): void {
  const folder = directory();
  if (!folder.exists) return;
  const files = folder.list().filter((entry): entry is File => entry instanceof File && entry.name.endsWith(extension));
  let total = files.reduce((sum, file) => sum + file.size, 0);
  const oldestFirst = files.sort((a, b) => (a.modificationTime ?? 0) - (b.modificationTime ?? 0));
  for (const file of oldestFirst) {
    if (total <= limitBytes) return;
    total -= file.size;
    file.delete();
  }
}
