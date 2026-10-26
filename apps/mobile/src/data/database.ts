import { drizzle } from "drizzle-orm/expo-sqlite";
import type { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import { getRandomValues } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { backupDatabaseAsync, deleteDatabaseAsync, openDatabaseAsync } from "expo-sqlite";
import type { SQLiteDatabase } from "expo-sqlite";
import { createIdFactory, schema, settings } from "@obnixe/schema";
import type { EpochMs } from "@obnixe/schema";
import type { Environment } from "@obnixe/core";

export type AppDatabase = ExpoSQLiteDatabase<typeof schema>;

export class DatabaseNotOpenError extends Error {
  constructor() {
    super("The database is used before openDatabase() resolved");
  }
}

const databaseName = "obnixe.db";

let connection: SQLiteDatabase | null = null;
let current: AppDatabase | null = null;

export async function openDatabase(): Promise<AppDatabase> {
  if (current !== null) return current;
  const sqlite = await openDatabaseAsync(databaseName, { enableChangeListener: true });
  connection = sqlite;
  await sqlite.execAsync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  current = drizzle(sqlite, { schema });
  return current;
}

async function closeConnection(): Promise<void> {
  const open = connection;
  connection = null;
  current = null;
  if (open !== null) await open.closeAsync();
}

async function backUpTo(name: string): Promise<void> {
  const source = await openDatabaseAsync(databaseName);
  try {
    const copy = await openDatabaseAsync(name);
    try {
      await backupDatabaseAsync({ sourceDatabase: source, destDatabase: copy });
    } finally {
      await copy.closeAsync();
    }
  } finally {
    await source.closeAsync();
  }
}

async function copyFilesTo(name: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = new File(Paths.document, "SQLite", `${databaseName}${suffix}`);
    if (file.exists) await file.copy(new File(Paths.document, "SQLite", `${name}${suffix}`));
  }
}

/**
 * Copies the database to dated files before deleting it, so a failed migration never destroys the only copy.
 * A file SQLite cannot open is copied byte for byte instead.
 */
export async function setDatabaseAside(): Promise<void> {
  const name = `obnixe-unreadable-${environment.now()}`;
  await closeConnection();
  try {
    await backUpTo(`${name}.db`);
  } catch (reason) {
    if (!(reason instanceof Error)) throw reason;
    await copyFilesTo(`${name}-raw.db`);
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
