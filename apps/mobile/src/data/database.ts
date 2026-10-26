import { drizzle } from "drizzle-orm/expo-sqlite";
import { getRandomValues } from "expo-crypto";
import { openDatabaseSync } from "expo-sqlite";
import { createIdFactory, schema, settings } from "@obnixe/schema";
import type { EpochMs } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "@obnixe/core";

const sqlite = openDatabaseSync("obnixe.db", { enableChangeListener: true });
sqlite.execSync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

export const expoDb = drizzle(sqlite, { schema });

export const db: ObnixeDatabase = expoDb;

export const environment: Environment = {
  now: () => Date.now() as EpochMs,
  newId: createIdFactory((bytes) => {
    getRandomValues(bytes);
  }, Date.now),
};

export function ensureSettings(): void {
  db.insert(settings)
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
