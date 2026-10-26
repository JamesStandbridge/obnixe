import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { journaled, journaledTables } from "@obnixe/schema";
import type { JournaledTable } from "@obnixe/schema";

export type DeleteAction = "cascade" | "set null" | "restrict";

export interface ForeignKey {
  readonly table: JournaledTable;
  readonly column: string;
  readonly target: JournaledTable;
  readonly nullable: boolean;
  readonly onDelete: DeleteAction;
}

const journaledNames: ReadonlySet<string> = new Set(journaledTables);

function deleteAction(value: string | undefined): DeleteAction {
  if (value === "cascade") return "cascade";
  if (value === "set null") return "set null";
  return "restrict";
}

function collect(): readonly ForeignKey[] {
  const keys: ForeignKey[] = [];
  for (const table of journaledTables) {
    const target = journaled[table] as SQLiteTable;
    const properties = new Map(Object.entries(getTableColumns(target)).map(([property, column]) => [column.name, property]));
    for (const foreignKey of getTableConfig(target).foreignKeys) {
      const reference = foreignKey.reference();
      const targetName = getTableName(reference.foreignTable);
      if (!journaledNames.has(targetName)) continue;
      const [column] = reference.columns;
      if (column === undefined || reference.columns.length !== 1) throw new Error(`Composite foreign key on ${table} is not supported`);
      const property = properties.get(column.name);
      if (property === undefined) throw new Error(`${table} has no property for ${column.name}`);
      keys.push({ table, column: property, target: targetName as JournaledTable, nullable: !column.notNull, onDelete: deleteAction(foreignKey.onDelete) });
    }
  }
  return keys;
}

export const foreignKeys: readonly ForeignKey[] = collect();

export function foreignKeysOf(table: JournaledTable): readonly ForeignKey[] {
  return foreignKeys.filter((key) => key.table === table);
}

export function foreignKeysTo(table: JournaledTable): readonly ForeignKey[] {
  return foreignKeys.filter((key) => key.target === table);
}

export function columnsOf(table: JournaledTable): readonly string[] {
  return Object.keys(getTableColumns(journaled[table] as SQLiteTable));
}
