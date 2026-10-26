import { drizzle } from "drizzle-orm/expo-sqlite";
import type { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import { getRandomValues } from "expo-crypto";
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

/** Copies the database to a dated file before deleting it, so a failed migration never destroys the only copy. */
export async function setDatabaseAside(): Promise<void> {
  const source = connection ?? (await openDatabaseAsync(databaseName));
  connection = null;
  current = null;
  const copy = await openDatabaseAsync(`obnixe-unreadable-${Date.now()}.db`);
  try {
    await backupDatabaseAsync({ sourceDatabase: source, destDatabase: copy });
  } finally {
    await copy.closeAsync();
    await source.closeAsync();
  }
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
