import type { JournaledTable, RowImage } from "@obnixe/schema";

const keyColumns: { readonly [T in JournaledTable]: readonly [string, ...string[]] } = {
  sport_preference: ["sport"],
  gear: ["id"],
  exercise: ["id"],
  exercise_zone: ["exerciseId", "zone"],
  measurement_kind: ["id"],
  program: ["id"],
  program_version: ["id"],
  program_slot: ["id"],
  program_variant: ["id"],
  program_item: ["id"],
  rotation_skip: ["id"],
  session: ["id"],
  strength_entry: ["id"],
  strength_set: ["id"],
  session_item: ["id"],
  weigh_in: ["id"],
  measurement: ["id"],
  photo: ["id"],
  check_in: ["id"],
  pain_report: ["id"],
  zone_tracking: ["id"],
};

const separator = "|";

export function keyColumnsOf(table: JournaledTable): readonly [string, ...string[]] {
  return keyColumns[table];
}

export function rowKey(table: JournaledTable, row: RowImage): string {
  return keyColumns[table].map((column) => String(row[column])).join(separator);
}

export function keyValues(table: JournaledTable, key: string): Record<string, string> {
  const parts = key.split(separator);
  const columns = keyColumns[table];
  if (parts.length !== columns.length) throw new Error(`Key ${key} does not match ${table}(${columns.join(", ")})`);
  return Object.fromEntries(columns.map((column, index) => [column, parts[index] ?? ""]));
}
