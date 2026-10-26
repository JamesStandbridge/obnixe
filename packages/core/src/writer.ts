import { and, eq, getTableColumns, getTableName, is, sql } from "drizzle-orm";
import type { InferInsertModel, SQL } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  change,
  changeset,
  itemValuesSchema,
  journaled,
  journaledTables,
  rowSchemas,
  schema,
  session,
  sessionItem,
  sessionValuesSchema,
  sports,
  targetValuesSchema,
} from "@obnixe/schema";
import type { Author, ChangeOperation, FieldValues, Id, JournaledTable, RowImage, SportKey } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "./database.ts";
import { keyColumnsOf, keyValues, rowKey } from "./keys.ts";

type Managed = "createdAt" | "updatedAt" | "changesetId";

export type NewRow<T extends JournaledTable> = Omit<InferInsertModel<(typeof journaled)[T]>, Managed>;

export type Mutation = {
  readonly [T in JournaledTable]:
    | { readonly kind: "insert"; readonly table: T; readonly row: NewRow<T> }
    | { readonly kind: "update"; readonly table: T; readonly key: string; readonly patch: Partial<NewRow<T>> }
    | { readonly kind: "delete"; readonly table: T; readonly key: string };
}[JournaledTable];

export interface Actor {
  readonly author: Author;
  readonly connectionId: Id | null;
}

export interface CommitRequest {
  readonly actor: Actor;
  readonly summary: string;
  readonly revertsId: Id | null;
  readonly mutations: readonly Mutation[];
}

export class RowNotFoundError extends Error {
  constructor(readonly table: JournaledTable, readonly key: string) {
    super(`${table} ${key} does not exist`);
  }
}

export class DuplicateRowError extends Error {
  constructor(readonly table: JournaledTable, readonly key: string) {
    super(`${table} ${key} already exists`);
  }
}

export class EmptyChangesetError extends Error {
  constructor(readonly summary: string) {
    super(`Changeset "${summary}" has no mutations`);
  }
}

export class DependentRowsError extends Error {
  constructor(readonly table: JournaledTable, readonly key: string, readonly dependents: readonly string[]) {
    super(`${table} ${key} is referenced by ${dependents.join(", ")}`);
  }
}

interface Dependent {
  readonly table: SQLiteTable;
  readonly columns: readonly SQLiteColumn[];
}

const journaledNames: ReadonlySet<string> = new Set(journaledTables);
const dependentsByTable = indexDependents();

export function commit(db: ObnixeDatabase, env: Environment, request: CommitRequest): Id {
  if (request.mutations.length === 0) throw new EmptyChangesetError(request.summary);
  const changesetId = env.newId();
  const now = env.now();
  db.transaction((tx) => {
    tx.insert(changeset)
      .values({ id: changesetId, author: request.actor.author, connectionId: request.actor.connectionId, summary: request.summary, revertsId: request.revertsId, createdAt: now })
      .run();
    request.mutations.forEach((mutation, sequence) => {
      const recorded = apply(tx, mutation, changesetId, now);
      tx.insert(change)
        .values({ changesetId, sequence, tableName: mutation.table, rowId: recorded.key, operation: recorded.operation, before: recorded.before, after: recorded.after })
        .run();
    });
  });
  return changesetId;
}

export function readRow(db: ObnixeDatabase, table: JournaledTable, key: string): RowImage | undefined {
  const target = journaled[table] as SQLiteTable;
  return db.select().from(target).where(keyCondition(table, key)).get() as RowImage | undefined;
}

interface Recorded {
  readonly key: string;
  readonly operation: ChangeOperation;
  readonly before: RowImage | null;
  readonly after: RowImage | null;
}

function apply(db: ObnixeDatabase, mutation: Mutation, changesetId: Id, now: number): Recorded {
  const target = journaled[mutation.table] as SQLiteTable;
  const columns = getTableColumns(target);
  switch (mutation.kind) {
    case "insert": {
      const row = withManaged(columns, { ...(mutation.row as RowImage) }, changesetId, now, true);
      const key = rowKey(mutation.table, row);
      if (readRow(db, mutation.table, key) !== undefined) throw new DuplicateRowError(mutation.table, key);
      const parsed = rowSchemas[mutation.table].parse(row) as RowImage;
      validateSportValues(db, mutation.table, parsed);
      db.insert(target).values(parsed).run();
      return { key, operation: "insert", before: null, after: required(db, mutation.table, key) };
    }
    case "update": {
      const before = required(db, mutation.table, mutation.key);
      const next = withManaged(columns, { ...before, ...(mutation.patch as RowImage) }, changesetId, now, false);
      if (rowKey(mutation.table, next) !== mutation.key) throw new Error(`Updating the key of ${mutation.table} ${mutation.key} is not allowed`);
      const parsed = rowSchemas[mutation.table].parse(next) as RowImage;
      validateSportValues(db, mutation.table, parsed);
      db.update(target).set(parsed).where(keyCondition(mutation.table, mutation.key)).run();
      return { key: mutation.key, operation: "update", before, after: required(db, mutation.table, mutation.key) };
    }
    case "delete": {
      const before = required(db, mutation.table, mutation.key);
      const dependents = referencingRows(db, mutation.table, before);
      if (dependents.length > 0) throw new DependentRowsError(mutation.table, mutation.key, dependents);
      db.delete(target).where(keyCondition(mutation.table, mutation.key)).run();
      return { key: mutation.key, operation: "delete", before, after: null };
    }
    default: {
      const unreachable: never = mutation;
      throw new Error(`Unhandled mutation ${JSON.stringify(unreachable)}`);
    }
  }
}

function validateSportValues(db: ObnixeDatabase, table: JournaledTable, row: RowImage): void {
  switch (table) {
    case "session": {
      const sport = sports[row.sport as SportKey];
      const values = sessionValuesSchema(sport).parse(row.values);
      for (const item of db.select({ values: sessionItem.values }).from(sessionItem).where(eq(sessionItem.sessionId, row.id as Id)).all()) {
        itemValuesSchema(sport, values).parse(item.values);
      }
      return;
    }
    case "session_item": {
      const sessionId = row.sessionId as Id;
      const parent = db.select({ sport: session.sport, values: session.values }).from(session).where(eq(session.id, sessionId)).get();
      if (parent === undefined) throw new RowNotFoundError("session", sessionId);
      itemValuesSchema(sports[parent.sport], parent.values).parse(row.values);
      return;
    }
    case "program_slot":
      targetValuesSchema(sports[row.sport as SportKey]).parse(row.targetValues as FieldValues);
      return;
    case "sport_preference":
    case "gear":
    case "exercise":
    case "exercise_zone":
    case "measurement_kind":
    case "program":
    case "program_version":
    case "program_variant":
    case "program_item":
    case "rotation_skip":
    case "strength_entry":
    case "strength_set":
    case "weigh_in":
    case "measurement":
    case "photo":
    case "check_in":
    case "pain_report":
    case "zone_tracking":
      return;
    default: {
      const unreachable: never = table;
      throw new Error(`Unhandled table ${String(unreachable)}`);
    }
  }
}

function withManaged(columns: Record<string, SQLiteColumn>, row: RowImage, changesetId: Id, now: number, inserting: boolean): RowImage {
  if ("updatedAt" in columns) row.updatedAt = now;
  if (inserting && "createdAt" in columns && row.createdAt === undefined) row.createdAt = now;
  if (inserting && "changesetId" in columns) row.changesetId = changesetId;
  return row;
}

function required(db: ObnixeDatabase, table: JournaledTable, key: string): RowImage {
  const row = readRow(db, table, key);
  if (row === undefined) throw new RowNotFoundError(table, key);
  return row;
}

export function keyCondition(table: JournaledTable, key: string): SQL {
  const columns = getTableColumns(journaled[table] as SQLiteTable);
  const values = keyValues(table, key);
  const conditions = keyColumnsOf(table).map((name) => {
    const column = columns[name];
    if (column === undefined) throw new Error(`${table} has no column ${name}`);
    return eq(column, values[name]);
  });
  const condition = and(...conditions);
  if (condition === undefined) throw new Error(`${table} has no key columns`);
  return condition;
}

function referencingRows(db: ObnixeDatabase, table: JournaledTable, row: RowImage): string[] {
  const found: string[] = [];
  for (const dependent of dependentsByTable.get(table) ?? []) {
    const id = row.id;
    if (typeof id !== "string") continue;
    for (const column of dependent.columns) {
      const hit = db.select({ one: sql<number>`1` }).from(dependent.table).where(eq(column, id)).limit(1).get();
      if (hit !== undefined) found.push(`${getTableName(dependent.table)}.${column.name}`);
    }
  }
  return found;
}

function indexDependents(): Map<JournaledTable, Dependent[]> {
  const index = new Map<JournaledTable, Dependent[]>();
  for (const candidate of Object.values(schema)) {
    if (!is(candidate, SQLiteTable)) continue;
    for (const foreignKey of getTableConfig(candidate).foreignKeys) {
      const reference = foreignKey.reference();
      const targetName = getTableName(reference.foreignTable);
      if (!journaledNames.has(targetName)) continue;
      const target = targetName as JournaledTable;
      const list = index.get(target) ?? [];
      list.push({ table: candidate, columns: reference.columns });
      index.set(target, list);
    }
  }
  return index;
}
