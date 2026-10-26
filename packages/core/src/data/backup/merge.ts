import { journaledTables, mergePolicies, settings as settingsTable } from "@obnixe/schema";
import type { Id, JournaledTable, MergePolicy, RowImage } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../../database.ts";
import { rowKey } from "../../keys.ts";
import { commit } from "../../writer.ts";
import type { Actor, Mutation } from "../../writer.ts";
import { foreignKeysOf } from "../foreignKeys.ts";
import type { ForeignKey } from "../foreignKeys.ts";
import { buildSnapshot, readSettings } from "./snapshot.ts";
import type { Snapshot, SnapshotSettings, SnapshotTables } from "./snapshot.ts";

export const importActor: Actor = { author: "import", connectionId: null };
export const mergeSummary = "Fusion d'une sauvegarde";

type Decision = "local" | "incoming" | "removed";

interface TableState {
  readonly local: ReadonlyMap<string, RowImage>;
  readonly rows: Map<string, RowImage>;
  readonly decisions: Map<string, Decision>;
}

type MergeState = { readonly [T in JournaledTable]: TableState };

export interface MergeCounts {
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
}

export interface MergePlan {
  readonly mutations: readonly Mutation[];
  readonly counts: MergeCounts;
  readonly settings: SnapshotSettings | null;
  readonly photoIds: readonly Id[];
}

export interface MergeResult {
  readonly changesetId: Id | null;
  readonly counts: MergeCounts;
  readonly photoIds: readonly Id[];
}

export class UnknownUniqueIndexError extends Error {
  constructor(readonly index: string) {
    super(`No merge predicate for unique index ${index}`);
  }
}

export class UnresolvedReferenceError extends Error {
  constructor(readonly table: JournaledTable, readonly key: string, readonly column: string) {
    super(`${table} ${key} keeps a required reference ${column} to a removed row`);
  }
}

const managedColumns: ReadonlySet<string> = new Set(["updatedAt", "changesetId"]);
const renumberOffset = 1_000_000;

type UniquePredicate = (candidate: RowImage, other: RowImage) => boolean;

const open = (row: RowImage): boolean => row.deletedAt === null || row.deletedAt === undefined;

const uniquePredicates: Readonly<Record<string, UniquePredicate>> = {
  program_single_active: (candidate, other) => candidate.status === "active" && other.status === "active",
  session_single_open: (candidate, other) => candidate.status !== "completed" && open(candidate) && other.status !== "completed" && open(other),
  zone_tracking_open: (candidate, other) => candidate.zone === other.zone && candidate.endedAt === null && other.endedAt === null,
};

function revision(row: RowImage): number {
  for (const column of ["updatedAt", "endedAt", "startedAt", "createdAt"]) {
    const value = row[column];
    if (typeof value === "number") return value;
  }
  return 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sameContent(left: RowImage, right: RowImage): boolean {
  const strip = (row: RowImage): RowImage => Object.fromEntries(Object.entries(row).filter(([column]) => !managedColumns.has(column)));
  return canonical(strip(left)) === canonical(strip(right));
}

function createState(tables: SnapshotTables): MergeState {
  const state: Partial<Record<JournaledTable, TableState>> = {};
  for (const table of journaledTables) {
    const local = new Map<string, RowImage>();
    for (const row of tables[table] as readonly RowImage[]) local.set(rowKey(table, row), row);
    state[table] = { local, rows: new Map(local), decisions: new Map([...local.keys()].map((key) => [key, "local" as Decision])) };
  }
  return state as MergeState;
}

type Remap = Map<JournaledTable, Map<string, string>>;

function remapReferences(row: RowImage, keys: readonly ForeignKey[], remap: Remap): RowImage {
  const next = { ...row };
  for (const key of keys) {
    const value = next[key.column];
    if (typeof value !== "string") continue;
    const mapped = remap.get(key.target)?.get(value);
    if (mapped !== undefined) next[key.column] = mapped;
  }
  return next;
}

function setRemap(remap: Remap, table: JournaledTable, from: string, to: string): void {
  const map = remap.get(table) ?? new Map<string, string>();
  map.set(from, to);
  remap.set(table, map);
}

function resolveUnique<T extends JournaledTable>(policy: MergePolicy<T>, state: TableState, key: string, row: RowImage): RowImage {
  if (policy.kind !== "newest") return row;
  let resolved = row;
  for (const unique of policy.unique) {
    const predicate = uniquePredicates[unique.index];
    if (predicate === undefined) throw new UnknownUniqueIndexError(unique.index);
    for (const [otherKey, other] of state.rows) {
      if (otherKey === key || !predicate(resolved, other)) continue;
      resolved = { ...resolved, ...(unique.patchIncoming(resolved as never, other as never) as RowImage) };
    }
  }
  return resolved;
}

function takeNewest<T extends JournaledTable>(policy: MergePolicy<T>, state: TableState, key: string, incoming: RowImage): void {
  const local = state.rows.get(key);
  if (local !== undefined && revision(incoming) <= revision(local)) {
    state.decisions.set(key, "local");
    return;
  }
  const next = local !== undefined && "createdAt" in local ? { ...incoming, createdAt: local.createdAt } : incoming;
  state.rows.set(key, resolveUnique(policy, state, key, next));
  state.decisions.set(key, "incoming");
}

function naturalKey<T extends JournaledTable>(policy: Extract<MergePolicy<T>, { kind: "natural_key" }>, row: RowImage): string {
  return policy.key
    .map((part) => {
      const value = String(row[part.column] ?? "");
      return part.normalize === "lower" ? value.toLowerCase() : value;
    })
    .join("\u0000");
}

function ownerDecision<T extends JournaledTable>(policy: Extract<MergePolicy<T>, { kind: "owned" }>, state: MergeState, row: RowImage): Decision | undefined {
  for (const owner of policy.owners) {
    const parent = row[owner.via];
    if (typeof parent === "string") return state[owner.parent].decisions.get(parent);
  }
  return undefined;
}

function mergeTable<T extends JournaledTable>(table: T, incomingRows: readonly RowImage[], state: MergeState, remap: Remap): void {
  const policy = mergePolicies[table] as MergePolicy<T>;
  const current = state[table];
  const keys = foreignKeysOf(table);
  const external = keys.filter((key) => key.target !== table);
  const internal = keys.filter((key) => key.target === table);
  const taken: string[] = [];
  for (const source of incomingRows) {
    const row = remapReferences(source, external, remap);
    const key = rowKey(table, row);
    switch (policy.kind) {
      case "newest":
        takeNewest(policy, current, key, row);
        break;
      case "immutable":
        if (!current.rows.has(key)) {
          current.rows.set(key, row);
          current.decisions.set(key, "incoming");
        }
        break;
      case "renumber":
        if (!current.rows.has(key)) {
          current.rows.set(key, row);
          current.decisions.set(key, "incoming");
        }
        break;
      case "owned": {
        if (ownerDecision(policy, state, row) !== "incoming") break;
        current.rows.set(key, row);
        current.decisions.set(key, "incoming");
        taken.push(key);
        break;
      }
      case "natural_key": {
        if (current.rows.has(key)) {
          takeNewest(policy, current, key, row);
          break;
        }
        const wanted = naturalKey(policy, row);
        const matches = [...current.rows.entries()].filter(([, candidate]) => naturalKey(policy, candidate) === wanted);
        const match = matches.find(([, candidate]) => candidate.mergedIntoId === null || candidate.mergedIntoId === undefined) ?? matches[0];
        if (match === undefined) {
          current.rows.set(key, row);
          current.decisions.set(key, "incoming");
        } else {
          setRemap(remap, table, key, match[0]);
        }
        break;
      }
      case "day_singleton": {
        if (current.rows.has(key)) {
          takeNewest(policy, current, key, row);
          break;
        }
        const match = open(row)
          ? [...current.rows.entries()].find(([, candidate]) => open(candidate) && policy.columns.every((column) => candidate[column] === row[column]))
          : undefined;
        if (match === undefined) {
          current.rows.set(key, row);
          current.decisions.set(key, "incoming");
          break;
        }
        const [matchKey, local] = match;
        setRemap(remap, table, key, matchKey);
        if (revision(row) > revision(local)) {
          current.rows.set(matchKey, { ...row, id: local.id, createdAt: local.createdAt });
          current.decisions.set(matchKey, "incoming");
        }
        break;
      }
      default: {
        const unreachable: never = policy;
        throw new Error(`Unhandled merge policy ${JSON.stringify(unreachable)}`);
      }
    }
  }
  if (policy.kind === "owned") {
    const incomingKeys = new Set(taken);
    for (const [key, row] of current.rows) {
      if (incomingKeys.has(key)) continue;
      const decision = ownerDecision(policy, state, row);
      if (decision === "incoming" || decision === "removed") {
        current.rows.delete(key);
        current.decisions.set(key, "removed");
      }
    }
  }
  if (internal.length > 0) {
    for (const [key, row] of current.rows) {
      if (current.decisions.get(key) === "incoming") current.rows.set(key, remapReferences(row, internal, remap));
    }
  }
  if (policy.kind === "renumber") renumber(policy, current);
}

function renumber<T extends JournaledTable>(policy: Extract<MergePolicy<T>, { kind: "renumber" }>, state: TableState): void {
  const lineages = new Map<string, [string, RowImage][]>();
  for (const entry of state.rows) {
    const lineage = String(entry[1][policy.lineage]);
    lineages.set(lineage, [...(lineages.get(lineage) ?? []), entry]);
  }
  for (const entries of lineages.values()) {
    entries.sort(([leftKey, left], [rightKey, right]) => revisionOrder(left, right, policy.orderBy) || leftKey.localeCompare(rightKey));
    entries.forEach(([key, row], index) => {
      if (row[policy.number] !== index + 1) state.rows.set(key, { ...row, [policy.number]: index + 1 });
    });
  }
}

function revisionOrder(left: RowImage, right: RowImage, column: string): number {
  return Number(left[column] ?? 0) - Number(right[column] ?? 0);
}

function enforceReferences(state: MergeState): void {
  for (const table of journaledTables) {
    const current = state[table];
    const keys = foreignKeysOf(table);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [key, row] of current.rows) {
        for (const foreignKey of keys) {
          const value = row[foreignKey.column];
          if (typeof value !== "string" || state[foreignKey.target].rows.has(value)) continue;
          changed = true;
          if (foreignKey.nullable) {
            current.rows.set(key, { ...row, [foreignKey.column]: null });
            break;
          }
          const local = current.local.get(key);
          if (local !== undefined && current.decisions.get(key) === "incoming" && keys.every((other) => typeof local[other.column] !== "string" || state[other.target].rows.has(local[other.column] as string))) {
            current.rows.set(key, local);
            current.decisions.set(key, "local");
          } else {
            current.rows.delete(key);
            current.decisions.set(key, "removed");
          }
          break;
        }
      }
    }
  }
}

function withoutManaged(row: RowImage): RowImage {
  return Object.fromEntries(Object.entries(row).filter(([column]) => !managedColumns.has(column)));
}

function patchOf(table: JournaledTable, row: RowImage): RowImage {
  const key = new Set(rowKey(table, row) === row.id ? ["id"] : []);
  return Object.fromEntries(Object.entries(withoutManaged(row)).filter(([column]) => !key.has(column) && column !== "createdAt"));
}

function orderBySelfReference(rows: readonly [string, RowImage][], keys: readonly ForeignKey[]): [string, RowImage][] {
  const pending = new Map(rows);
  const ordered: [string, RowImage][] = [];
  while (pending.size > 0) {
    const before = pending.size;
    for (const [key, row] of pending) {
      const waits = keys.some((foreignKey) => {
        const value = row[foreignKey.column];
        return typeof value === "string" && value !== key && pending.has(value);
      });
      if (waits) continue;
      ordered.push([key, row]);
      pending.delete(key);
    }
    if (pending.size === before) {
      ordered.push(...pending);
      break;
    }
  }
  return ordered;
}

function emit(state: MergeState): MergePlan {
  const preliminary: Mutation[] = [];
  const deletes: Mutation[] = [];
  const writes: Mutation[] = [];
  const photoIds: Id[] = [];
  let inserted = 0;
  let updated = 0;
  const removed = new Map<JournaledTable, ReadonlySet<string>>(
    journaledTables.map((table) => [table, new Set([...state[table].local.keys()].filter((key) => !state[table].rows.has(key)))]),
  );
  const removedKeys = (table: JournaledTable): ReadonlySet<string> => removed.get(table) ?? new Set<string>();
  for (const table of journaledTables) {
    const current = state[table];
    const policy = mergePolicies[table];
    const keys = foreignKeysOf(table);
    const inserts: [string, RowImage][] = [];
    const updates: [string, RowImage][] = [];
    for (const [key, row] of current.rows) {
      const local = current.local.get(key);
      if (local === undefined) inserts.push([key, row]);
      else if (!sameContent(local, row)) updates.push([key, row]);
    }
    for (const [key, row] of updates) {
      const local = current.local.get(key) as RowImage;
      const released: RowImage = {};
      for (const foreignKey of keys) {
        const before = local[foreignKey.column];
        if (typeof before !== "string" || before === row[foreignKey.column] || !removedKeys(foreignKey.target).has(before)) continue;
        if (!foreignKey.nullable) throw new UnresolvedReferenceError(table, key, foreignKey.column);
        released[foreignKey.column] = null;
      }
      if (Object.keys(released).length > 0) preliminary.push({ kind: "update", table, key, patch: released } as Mutation);
    }
    const renumbered = policy.kind === "renumber" ? updates.filter(([key, row]) => (current.local.get(key) as RowImage)[policy.number] !== row[policy.number]) : [];
    if (policy.kind === "renumber") {
      for (const [key, row] of renumbered) {
        writes.push({ kind: "update", table, key, patch: { [policy.number]: Number(row[policy.number]) + renumberOffset } } as Mutation);
      }
    }
    for (const [key, row] of updates) {
      writes.push({ kind: "update", table, key, patch: patchOf(table, row) } as Mutation);
      if (table === "photo") photoIds.push(row.id as Id);
    }
    for (const [, row] of orderBySelfReference(inserts, keys.filter((key) => key.target === table))) {
      writes.push({ kind: "insert", table, row: withoutManaged(row) } as Mutation);
      if (table === "photo") photoIds.push(row.id as Id);
    }
    inserted += inserts.length;
    updated += updates.length;
  }
  let deleted = 0;
  for (const table of [...journaledTables].reverse()) {
    for (const key of removedKeys(table)) {
      deletes.push({ kind: "delete", table, key } as Mutation);
      deleted += 1;
    }
  }
  return { mutations: [...preliminary, ...deletes, ...writes], counts: { inserted, updated, deleted }, settings: null, photoIds };
}

export function planMerge(db: ObnixeDatabase, incoming: Snapshot): MergePlan {
  const local = buildSnapshot(db, 0 as Snapshot["createdAt"]);
  const state = createState(local.tables);
  const remap: Remap = new Map();
  for (const table of journaledTables) mergeTable(table, incoming.tables[table] as readonly RowImage[], state, remap);
  enforceReferences(state);
  const plan = emit(state);
  const settings = incoming.settings.updatedAt > local.settings.updatedAt ? incoming.settings : null;
  return { ...plan, settings };
}

export function mergeSnapshot(db: ObnixeDatabase, env: Environment, incoming: Snapshot): MergeResult {
  const plan = planMerge(db, incoming);
  let changesetId: Id | null = null;
  db.transaction((tx) => {
    if (plan.mutations.length > 0) changesetId = commit(tx, env, { actor: importActor, summary: mergeSummary, revertsId: null, mutations: plan.mutations });
    if (plan.settings !== null) applySettings(tx, plan.settings, env);
  });
  return { changesetId, counts: plan.counts, photoIds: plan.photoIds };
}

function applySettings(db: ObnixeDatabase, next: SnapshotSettings, env: Environment): void {
  const current = readSettings(db);
  db.update(settingsTable).set({ ...current, ...next, updatedAt: env.now() }).run();
}
