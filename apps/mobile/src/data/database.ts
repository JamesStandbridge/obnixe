import { drizzle } from "drizzle-orm/expo-sqlite";
import type { ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import { getRandomValues } from "expo-crypto";
import { openDatabaseAsync } from "expo-sqlite";
import { createIdFactory, schema, settings } from "@obnixe/schema";
import type { EpochMs } from "@obnixe/schema";
import type { Environment } from "@obnixe/core";

export type AppDatabase = ExpoSQLiteDatabase<typeof schema>;

export class DatabaseNotOpenError extends Error {
  constructor() {
    super("The database is used before openDatabase() resolved");
  }
}

let current: AppDatabase | null = null;

export async function openDatabase(): Promise<AppDatabase> {
  if (current !== null) return current;
  const sqlite = await openDatabaseAsync("obnixe.db", { enableChangeListener: true });
  await sqlite.execAsync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  current = drizzle(sqlite, { schema });
  return current;
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
