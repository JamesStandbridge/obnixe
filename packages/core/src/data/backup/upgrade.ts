import { getTableColumns, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { journaled, journaledTables, settings } from "@obnixe/schema";
import type { ObnixeDatabase } from "../../database.ts";
import type { PackedSnapshot } from "./container.ts";
import { buildSnapshot, CorruptedBackupError, InvalidSnapshotError, parseSnapshotSettings, parseSnapshotTables } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";

/** Shape of `@obnixe/schema/migrations`: the drizzle journal and the SQL of each migration keyed `m0000`, `m0001`… */
export interface MigrationBundle {
  readonly journal: { readonly entries: readonly { readonly idx: number; readonly tag: string }[] };
  readonly migrations: Readonly<Record<string, string>>;
}

export interface ScratchDatabase {
  readonly db: ObnixeDatabase;
  readonly close: () => void;
}

/** Platform services needed to convert an old snapshot: the bundled migrations and an empty in-memory database. */
export interface SnapshotUpgrader {
  readonly migrations: MigrationBundle;
  readonly openScratch: () => ScratchDatabase;
}

/** Last migration applied by the app that wrote each backup schema version. */
export const backupSchemaMigrations: Readonly<Record<number, string>> = {
  1: "0001_entry_planned_sets",
  2: "0003_trail_sport",
  3: "0005_mask_in_app",
  4: "0008_routes",
  5: "0009_guided_workouts",
  6: "0010_gear_wear",
  7: "0011_ble_sensors_power",
};

const statementBreakpoint = "--> statement-breakpoint";

interface MappedColumn {
  readonly property: string;
  readonly column: SQLiteColumn;
}

/**
 * Loads the snapshot into a scratch database at the schema of its version, then runs the remaining migrations and reads it back.
 * The SQL migrations stay the only definition of every data conversion, shared by app updates and restores.
 */
export function upgradeSnapshot(packed: PackedSnapshot, upgrader: SnapshotUpgrader): Snapshot {
  const lastApplied = backupSchemaMigrations[packed.schemaVersion];
  if (lastApplied === undefined) throw new CorruptedBackupError(`unknown schema version ${packed.schemaVersion}`);
  const entries = [...upgrader.migrations.journal.entries].sort((left, right) => left.idx - right.idx);
  const split = entries.findIndex((entry) => entry.tag === lastApplied) + 1;
  if (split === 0) throw new Error(`Migration ${lastApplied} is not bundled`);
  const scratch = upgrader.openScratch();
  try {
    const { db } = scratch;
    db.run(sql`PRAGMA foreign_keys = OFF`);
    applyMigrations(db, upgrader.migrations, entries.slice(0, split));
    insertSnapshot(db, packed);
    applyMigrations(db, upgrader.migrations, entries.slice(split));
    const upgraded = buildSnapshot(db, packed.createdAt, packed.photos, packed.tracks);
    return { ...upgraded, settings: parseSnapshotSettings(upgraded.settings), tables: parseSnapshotTables(upgraded.tables) };
  } finally {
    scratch.close();
  }
}

function applyMigrations(db: ObnixeDatabase, bundle: MigrationBundle, entries: readonly { readonly idx: number; readonly tag: string }[]): void {
  for (const entry of entries) {
    const source = bundle.migrations[`m${String(entry.idx).padStart(4, "0")}`];
    if (source === undefined) throw new Error(`Migration ${entry.tag} is not bundled`);
    for (const statement of source.split(statementBreakpoint)) {
      if (statement.trim() !== "") db.run(sql.raw(statement));
    }
  }
}

function insertSnapshot(db: ObnixeDatabase, packed: PackedSnapshot): void {
  const tables = record(packed.tables, "tables");
  for (const table of journaledTables) {
    const rows = tables[table];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) throw new InvalidSnapshotError(table, 0, "is not a list");
    insertRows(db, journaled[table] as SQLiteTable, table, rows);
  }
  insertRows(db, settings, "settings", [{ ...record(packed.settings, "settings"), singleton: 1 }]);
}

/** Inserts only the columns the table has at the snapshot's schema version; later columns get their migration defaults. */
function insertRows(db: ObnixeDatabase, target: SQLiteTable, table: string, rows: readonly unknown[]): void {
  if (rows.length === 0) return;
  const byName = new Map(Object.entries(getTableColumns(target)).map(([property, column]) => [column.name, { property, column }]));
  const columns = db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info(${table})`).map(({ name }): MappedColumn => {
    const mapped = byName.get(name);
    if (mapped === undefined) throw new Error(`${table}.${name} has no counterpart in the current schema`);
    return mapped;
  });
  const names = sql.join(
    columns.map(({ column }) => sql.identifier(column.name)),
    sql`, `,
  );
  rows.forEach((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new InvalidSnapshotError(table, index, "is not an object");
    const row = raw as Record<string, unknown>;
    const values = columns.map(({ property, column }) => {
      const value = row[property];
      return sql`${value === undefined || value === null ? null : column.mapToDriverValue(value)}`;
    });
    db.run(sql`INSERT INTO ${sql.identifier(table)} (${names}) VALUES (${sql.join(values, sql`, `)})`);
  });
}

function record(value: unknown, part: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CorruptedBackupError(`${part} missing`);
  return value as Record<string, unknown>;
}
