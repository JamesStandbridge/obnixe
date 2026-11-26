import { randomFillSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createIdFactory, schema } from "@obnixe/schema";
import type { EpochMs } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "./database.ts";
import type { MigrationBundle, SnapshotUpgrader } from "./data/backup/upgrade.ts";

export interface TestContext {
  readonly db: ObnixeDatabase;
  readonly env: Environment;
  readonly advance: (ms: number) => void;
}

const require = createRequire(import.meta.url);
const migrationsFolder = join(dirname(require.resolve("@obnixe/schema/package.json")), "migrations");

/** `initialSql` loads a database written by an older app version (an `.dump` of it) before the migrations run. */
export function createTestContext(initialSql?: string): TestContext {
  const sqlite = new Database(":memory:");
  if (initialSql !== undefined) sqlite.exec(initialSql);
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder });
  let clock = Date.UTC(2026, 9, 24, 14, 0);
  const env: Environment = { now: () => clock as EpochMs, newId: createIdFactory(randomFillSync, () => clock) };
  return { db, env, advance: (ms) => (clock += ms) };
}

function loadMigrations(): MigrationBundle {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as MigrationBundle["journal"];
  const migrations = Object.fromEntries(journal.entries.map((entry) => [`m${String(entry.idx).padStart(4, "0")}`, readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8")]));
  return { journal, migrations };
}

export const testUpgrader: SnapshotUpgrader = {
  migrations: loadMigrations(),
  openScratch: () => {
    const sqlite = new Database(":memory:");
    return { db: drizzle({ client: sqlite, schema }), close: () => sqlite.close() };
  },
};
