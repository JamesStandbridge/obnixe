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

function deleteWithCompanions(name: string): void {
  for (const file of filesOf(name)) file.delete();
}

/** Folds a duplicate of the copy and its write-ahead log into one standalone file, leaving the copy itself untouched. */
async function standalone(copy: AsideCopy): Promise<File> {
  const directory = exportDirectory();
  directory.create({ idempotent: true, intermediates: true });
  const target = new File(directory, copy.name);
  if (target.exists) target.delete();
  const duplicate = `obnixe-export-${Date.now()}.db`;
  try {
    new File(sqliteDirectory(), copy.name).copy(new File(sqliteDirectory(), duplicate));
    const log = new File(sqliteDirectory(), `${copy.name}-wal`);
    if (log.exists) log.copy(new File(sqliteDirectory(), `${duplicate}-wal`));
    const database = await openDatabaseAsync(duplicate);
    try {
      await database.execAsync(`VACUUM INTO '${pathOf(target).replace(/'/g, "''")}'`);
    } finally {
      await database.closeAsync();
    }
  } finally {
    deleteWithCompanions(duplicate);
  }
  return target;
}

async function shareFile(file: File, title: string): Promise<void> {
  await shareAsync(file.uri, { mimeType: "application/vnd.sqlite3", UTI: "public.database", dialogTitle: title });
}

export type ShareOutcome = { readonly kind: "shared" } | { readonly kind: "separate"; readonly fileCount: number };

/** A copy SQLite cannot open comes back as its separate files, which must be shared together for the log to stay with the database. */
export async function shareAsideCopy(copy: AsideCopy): Promise<ShareOutcome> {
  const files = filesOf(copy.name);
  if (files.length <= 1) {
    await shareFile(new File(sqliteDirectory(), copy.name), copy.name);
    return { kind: "shared" };
  }
  let target: File;
  try {
    target = await standalone(copy);
  } catch (error) {
    if (!(error instanceof CodedError)) throw error;
    return { kind: "separate", fileCount: files.length };
  }
  try {
    await shareFile(target, copy.name);
  } finally {
    if (target.exists) target.delete();
  }
  return { kind: "shared" };
}

export async function shareSeparately(copy: AsideCopy): Promise<void> {
  for (const file of filesOf(copy.name)) await shareFile(file, file.name);
}

export function deleteAsideCopy(copy: AsideCopy): void {
  deleteWithCompanions(copy.name);
}
