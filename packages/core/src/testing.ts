import { randomFillSync } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createIdFactory, schema } from "@obnixe/schema";
import type { EpochMs } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "./database.ts";

export interface TestContext {
  readonly db: ObnixeDatabase;
  readonly env: Environment;
  readonly advance: (ms: number) => void;
}

const require = createRequire(import.meta.url);
const migrationsFolder = join(dirname(require.resolve("@obnixe/schema/package.json")), "migrations");

export function createTestContext(): TestContext {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder });
  let clock = Date.UTC(2026, 9, 24, 14, 0);
  const env: Environment = { now: () => clock as EpochMs, newId: createIdFactory(randomFillSync, () => clock) };
  return { db, env, advance: (ms) => (clock += ms) };
}
