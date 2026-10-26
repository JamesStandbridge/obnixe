import { CodedError } from "expo";
import { Directory, File, Paths } from "expo-file-system";
import { shareAsync } from "expo-sharing";
import { openDatabaseAsync } from "expo-sqlite";
import type { EpochMs } from "@obnixe/schema";
import { asidePrefix } from "@/data/database";

export interface AsideCopy {
  readonly name: string;
  readonly setAsideAt: EpochMs;
  readonly bytes: number;
  readonly raw: boolean;
}

const companionSuffixes = ["-wal", "-shm"] as const;
const copyName = new RegExp(`^${asidePrefix}(\\d+)(-raw)?\\.db$`);

const sqliteDirectory = (): Directory => new Directory(Paths.document, "SQLite");
const exportDirectory = (): Directory => new Directory(Paths.cache, "exports");

function filesOf(name: string): File[] {
  return [name, ...companionSuffixes.map((suffix) => `${name}${suffix}`)].map((file) => new File(sqliteDirectory(), file)).filter((file) => file.exists);
}

export function listAsideCopies(): AsideCopy[] {
  const directory = sqliteDirectory();
  if (!directory.exists) return [];
  return directory
    .list()
    .flatMap((entry): AsideCopy[] => {
      if (!(entry instanceof File)) return [];
      const match = copyName.exec(entry.name);
      if (match === null) return [];
      return [{ name: entry.name, setAsideAt: Number(match[1]) as EpochMs, bytes: filesOf(entry.name).reduce((sum, file) => sum + (file.size ?? 0), 0), raw: match[2] !== undefined }];
    })
    .sort((left, right) => right.setAsideAt - left.setAsideAt);
}

function pathOf(file: File): string {
  return decodeURIComponent(file.uri.replace(/^file:\/\//, ""));
}

/** Folds the copy and its write-ahead log into one standalone database file. */
async function standalone(copy: AsideCopy): Promise<File> {
  const directory = exportDirectory();
  directory.create({ idempotent: true, intermediates: true });
  const target = new File(directory, copy.name);
  if (target.exists) target.delete();
  const database = await openDatabaseAsync(copy.name);
  try {
    await database.execAsync(`VACUUM INTO '${pathOf(target).replace(/'/g, "''")}'`);
  } finally {
    await database.closeAsync();
  }
  return target;
}

async function shareFile(file: File, title: string): Promise<void> {
  await shareAsync(file.uri, { mimeType: "application/vnd.sqlite3", UTI: "public.database", dialogTitle: title });
}

/** A copy SQLite cannot open is shared file by file, so its write-ahead log still travels with it. */
export async function shareAsideCopy(copy: AsideCopy): Promise<void> {
  const files = filesOf(copy.name);
  if (files.length <= 1) {
    await shareFile(new File(sqliteDirectory(), copy.name), copy.name);
    return;
  }
  let target: File;
  try {
    target = await standalone(copy);
  } catch (error) {
    if (!(error instanceof CodedError)) throw error;
    for (const file of files) await shareFile(file, file.name);
    return;
  }
  await shareFile(target, copy.name);
}

export function deleteAsideCopy(copy: AsideCopy): void {
  for (const file of filesOf(copy.name)) file.delete();
}
