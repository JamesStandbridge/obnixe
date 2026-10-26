import type { JournaledTable } from "./enums.ts";
import type { Change } from "./schema.ts";

export type RowImage = Record<string, unknown>;

type VersionRoot = "program_version";

const versionRoots: ReadonlySet<JournaledTable> = new Set<VersionRoot>(["program_version"]);
const versionChildren: ReadonlySet<JournaledTable> = new Set<JournaledTable>(["program_slot", "program_variant", "program_item"]);

export type RevertOperation =
  | { readonly kind: "insert"; readonly table: JournaledTable; readonly row: RowImage }
  | { readonly kind: "update"; readonly table: JournaledTable; readonly rowId: string; readonly row: RowImage }
  | { readonly kind: "delete"; readonly table: JournaledTable; readonly rowId: string }
  | { readonly kind: "restore_previous_version"; readonly table: VersionRoot; readonly versionId: string };

export interface RevertConflict {
  readonly table: JournaledTable;
  readonly rowId: string;
}

export interface RevertPlan {
  readonly operations: readonly RevertOperation[];
  readonly conflicts: readonly RevertConflict[];
}

export type CurrentRow = (table: JournaledTable, rowId: string) => RowImage | undefined;

export function planRevert(changes: readonly Change[], current: CurrentRow): RevertPlan {
  const operations: RevertOperation[] = [];
  const conflicts: RevertConflict[] = [];
  const simulated = new Map<string, RowImage | undefined>();
  const ordered = [...changes].sort((left, right) => right.sequence - left.sequence);
  for (const change of ordered) {
    if (change.operation === "insert" && versionRoots.has(change.tableName)) {
      operations.push({ kind: "restore_previous_version", table: change.tableName as VersionRoot, versionId: change.rowId });
      continue;
    }
    if (change.operation === "insert" && versionChildren.has(change.tableName)) continue;
    const key = `${change.tableName}:${change.rowId}`;
    const now = simulated.has(key) ? simulated.get(key) : current(change.tableName, change.rowId);
    if (!sameImage(now, change.after ?? undefined)) {
      conflicts.push({ table: change.tableName, rowId: change.rowId });
      continue;
    }
    simulated.set(key, change.before ?? undefined);
    operations.push(inverse(change));
  }
  return { operations: conflicts.length === 0 ? operations : [], conflicts };
}

function inverse(change: Change): RevertOperation {
  switch (change.operation) {
    case "insert":
      return { kind: "delete", table: change.tableName, rowId: change.rowId };
    case "update":
      return { kind: "update", table: change.tableName, rowId: change.rowId, row: required(change.before, change) };
    case "delete":
      return { kind: "insert", table: change.tableName, row: required(change.before, change) };
    default: {
      const unreachable: never = change.operation;
      throw new Error(`Unhandled change operation ${String(unreachable)}`);
    }
  }
}

function required(image: RowImage | null, change: Change): RowImage {
  if (image === null) throw new Error(`Change ${change.changesetId}#${change.sequence} has no before image`);
  return image;
}

function sameImage(left: RowImage | undefined, right: RowImage | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
