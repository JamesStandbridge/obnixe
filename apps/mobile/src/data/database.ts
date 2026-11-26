import { drizzle } from "drizzle-orm/expo-sqlite";
import type { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import { getRandomValues } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { backupDatabaseAsync, deleteDatabaseAsync, openDatabaseAsync } from "expo-sqlite";
import type { SQLiteDatabase } from "expo-sqlite";
import { Platform } from "react-native";
import { backup, catalogVersion, createIdFactory, schema, settings } from "@obnixe/schema";
import type { EpochMs } from "@obnixe/schema";
import migrations from "@obnixe/schema/migrations";
import type { Environment } from "@obnixe/core";

export type AppDatabase = ExpoSQLiteDatabase<typeof schema>;

export class DatabaseNotOpenError extends Error {
  constructor() {
    super("The database is used before openDatabase() resolved");
  }
}

const databaseName = "obnixe.db";

export const asidePrefix = "obnixe-unreadable-";

export const safetyCopyPrefix = "obnixe-pre-migration-";

/** `DAT-033`: the database as it was before a pending migration, in the SQLite folder; a failed migration keeps reusing it. */
export interface SafetyCopy {
  readonly name: string;
  readonly takenAt: EpochMs;
  /** Applied migrations of the copy. */
  readonly schemaVersion: number;
}

let connection: SQLiteDatabase | null = null;
let current: AppDatabase | null = null;
let safetyCopy: SafetyCopy | null = null;

/** Applied migrations, or null when the journal has nothing left to apply or the database is new. */
async function appliedBeforePending(sqlite: SQLiteDatabase): Promise<number | null> {
  const table = await sqlite.getFirstAsync<{ readonly name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'");
  if (table === null) return null;
  const applied = await sqlite.getAllAsync<{ readonly createdAt: number }>("SELECT created_at AS createdAt FROM __drizzle_migrations");
  const last = Math.max(0, ...applied.map((row) => row.createdAt));
  const pending = migrations.journal.entries.filter((entry) => entry.when > last);
  return applied.length === 0 || pending.length === 0 ? null : applied.length;
}

async function takeSafetyCopy(sqlite: SQLiteDatabase): Promise<void> {
  const schemaVersion = await appliedBeforePending(sqlite);
  if (schemaVersion === null || Platform.OS === "web") return;
  const base = `${safetyCopyPrefix}${schemaVersion}`;
  const kept = [`${base}.db`, `${base}-raw.db`].find((name) => safetyCopyFile(name).exists);
  const name = kept ?? (await copyDatabase(sqlite, base));
  safetyCopy = { name, takenAt: environment.now(), schemaVersion };
}

export async function openDatabase(): Promise<AppDatabase> {
  if (current !== null) return current;
  const sqlite = await openDatabaseAsync(databaseName, { enableChangeListener: true });
  connection = sqlite;
  await sqlite.execAsync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  await takeSafetyCopy(sqlite);
  current = drizzle(sqlite, { schema });
  return current;
}

/** The copy taken before this launch's migration, which the migration error screen offers to export. */
export function pendingSafetyCopy(): SafetyCopy | null {
  return safetyCopy;
}

export function safetyCopyFile(name: string): File {
  return new File(Paths.document, "SQLite", name);
}

export function deleteSafetyCopy(name: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = safetyCopyFile(`${name}${suffix}`);
    if (file.exists) file.delete();
  }
}

/** Once the migration succeeded the copy is listed with the backups and kept 30 days. */
export function recordSafetyCopy(): void {
  const copy = safetyCopy;
  if (copy === null) return;
  safetyCopy = null;
  const file = safetyCopyFile(copy.name);
  db()
    .insert(backup)
    .values({
      id: environment.newId(),
      kind: "pre_migration",
      schemaVersion: copy.schemaVersion,
      catalogVersion,
      includesPhotos: false,
      sizeBytes: file.exists ? file.size : 0,
      coveredFrom: null,
      coveredTo: null,
      snapshotFile: copy.name,
      createdAt: copy.takenAt,
    })
    .run();
}

async function closeConnection(): Promise<void> {
  const open = connection;
  connection = null;
  current = null;
  if (open !== null) await open.closeAsync();
}

async function backUpTo(source: SQLiteDatabase, name: string): Promise<void> {
  const copy = await openDatabaseAsync(name);
  try {
    await backupDatabaseAsync({ sourceDatabase: source, destDatabase: copy });
  } finally {
    await copy.closeAsync();
  }
}

function copyFilesTo(name: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = new File(Paths.document, "SQLite", `${databaseName}${suffix}`);
    if (file.exists) file.copy(new File(Paths.document, "SQLite", `${name}${suffix}`));
  }
}

/** Whatever makes the SQLite backup fail, the files are then copied byte for byte instead; resolves the copy's file name. */
async function copyDatabase(source: SQLiteDatabase, name: string): Promise<string> {
  try {
    await backUpTo(source, `${name}.db`);
    return `${name}.db`;
  } catch (reason) {
    if (!(reason instanceof Error)) throw reason;
    const partial = new File(Paths.document, "SQLite", `${name}.db`);
    if (partial.exists) partial.delete();
    copyFilesTo(`${name}-raw.db`);
    return `${name}-raw.db`;
  }
}

/** Copies the database to dated files before deleting it, so a failed migration never destroys the only copy. */
export async function setDatabaseAside(): Promise<void> {
  const name = `${asidePrefix}${environment.now()}`;
  await closeConnection();
  const source = await openDatabaseAsync(databaseName);
  try {
    await copyDatabase(source, name);
  } finally {
    await source.closeAsync();
  }
  await deleteDatabaseAsync(databaseName);
}

export async function eraseDatabase(): Promise<void> {
  await closeConnection();
  await deleteDatabaseAsync(databaseName);
}

export function db(): AppDatabase {
  if (current === null) throw new DatabaseNotOpenError();
  return current;
}

export const environment: Environment = {
  now: () => Date.now() as EpochMs,
  newId: createIdFactory((bytes) => {
    getRandomValues(bytes);
  }, Date.now),
};

export function ensureSettings(): void {
  db()
    .insert(settings)
    .values({
      singleton: 1,
      theme: "dark",
      massUnit: "kg",
      agentCanReadBody: false,
      agentCanWrite: false,
      agentCanReadPhotos: false,
      reminderWeekdays: 0,
      reminderMinutes: 18 * 60 + 30,
      remindersExportedAt: null,
      agentChangesSeenAt: null,
      updatedAt: environment.now(),
    })
    .onConflictDoNothing()
    .run();
}
