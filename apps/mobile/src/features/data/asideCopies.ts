import { CodedError } from "expo";
import { Platform } from "react-native";
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

function pathOf(entry: File | Directory): string {
  return decodeURIComponent(entry.uri.replace(/^file:\/\//, ""));
}

function deleteWithCompanions(name: string): void {
  for (const file of filesOf(name)) file.delete();
}

/** Android hands the file to the receiving app after the chooser closes, so exports are only removed by the next sweep. */
export function sweepExports(): void {
  const directory = exportDirectory();
  if (directory.exists) directory.delete();
}

async function vacuumInto(source: Directory, name: string, target: File): Promise<void> {
  const database = await openDatabaseAsync(name, undefined, pathOf(source));
  let failure: unknown = null;
  try {
    await database.execAsync(`VACUUM INTO '${pathOf(target).replace(/'/g, "''")}'`);
  } catch (error) {
    failure = error;
  }
  try {
    await database.closeAsync();
  } catch (error) {
    if (failure === null) throw error;
  }
  if (failure !== null) throw failure;
}

/** Folds a duplicate of the copy and its write-ahead log, kept in the cache, into one standalone file; the copy itself is never opened. */
async function standalone(copy: AsideCopy): Promise<File> {
  sweepExports();
  const directory = exportDirectory();
  const work = new Directory(directory, "work");
  work.create({ idempotent: true, intermediates: true });
  const duplicate = `obnixe-export-${Date.now()}.db`;
  new File(sqliteDirectory(), copy.name).copy(new File(work, duplicate));
  const log = new File(sqliteDirectory(), `${copy.name}-wal`);
  if (log.exists) log.copy(new File(work, `${duplicate}-wal`));
  const target = new File(directory, copy.name);
  try {
    await vacuumInto(work, duplicate, target);
  } catch (error) {
    if (target.exists) target.delete();
    throw error;
  } finally {
    work.delete();
  }
  return target;
}

async function shareFile(file: File, title: string): Promise<void> {
  await shareAsync(file.uri, { mimeType: "application/vnd.sqlite3", UTI: "public.database", dialogTitle: title });
}

/** The shared memory index is rebuilt by SQLite, so only the database and its write-ahead log need to travel. */
function separateFiles(copy: AsideCopy): File[] {
  return filesOf(copy.name).filter((file) => !file.name.endsWith("-shm"));
}

export type ShareOutcome = { readonly kind: "shared" } | { readonly kind: "separate"; readonly fileCount: number };

/** A copy SQLite cannot open comes back as its separate files, which must be shared together for the log to stay with the database. */
export async function shareAsideCopy(copy: AsideCopy): Promise<ShareOutcome> {
  const files = separateFiles(copy);
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
  await shareFile(target, copy.name);
  if (Platform.OS === "ios" && target.exists) target.delete();
  return { kind: "shared" };
}

export async function shareSeparately(copy: AsideCopy): Promise<void> {
  for (const file of separateFiles(copy)) await shareFile(file, file.name);
}

export function deleteAsideCopy(copy: AsideCopy): void {
  deleteWithCompanions(copy.name);
}
