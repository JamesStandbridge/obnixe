import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { agentCall, backup, change, changeset, checkIn, journaled, journaledTables, measurement, painReport, photo, session, weighIn } from "@obnixe/schema";
import type { Backup, CheckIn, EpochMs, Id, JournaledTable, Measurement, PainReport, Photo, RowImage, Session, WeighIn } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import { rowKey } from "../keys.ts";
import { keyCondition } from "../writer.ts";
import type { Mutation } from "../writer.ts";
import { foreignKeysTo } from "./foreignKeys.ts";

export const trashRetentionMs = 30 * 86_400_000;

export type TrashItem =
  | { readonly table: "session"; readonly row: Session; readonly expiresAt: EpochMs }
  | { readonly table: "weigh_in"; readonly row: WeighIn; readonly expiresAt: EpochMs }
  | { readonly table: "measurement"; readonly row: Measurement; readonly expiresAt: EpochMs }
  | { readonly table: "photo"; readonly row: Photo; readonly expiresAt: EpochMs }
  | { readonly table: "check_in"; readonly row: CheckIn; readonly expiresAt: EpochMs }
  | { readonly table: "pain_report"; readonly row: PainReport; readonly expiresAt: EpochMs };

export type TrashableTable = TrashItem["table"];

export const trashableTables: readonly TrashableTable[] = ["session", "weigh_in", "measurement", "photo", "check_in", "pain_report"];

const expiry = (deletedAt: EpochMs | null): EpochMs => ((deletedAt ?? 0) + trashRetentionMs) as EpochMs;

export function trashItems(db: ObnixeDatabase): readonly TrashItem[] {
  const items: TrashItem[] = [
    ...db.select().from(session).where(isNotNull(session.deletedAt)).all().map((row): TrashItem => ({ table: "session", row, expiresAt: expiry(row.deletedAt) })),
    ...db.select().from(weighIn).where(isNotNull(weighIn.deletedAt)).all().map((row): TrashItem => ({ table: "weigh_in", row, expiresAt: expiry(row.deletedAt) })),
    ...db.select().from(measurement).where(isNotNull(measurement.deletedAt)).all().map((row): TrashItem => ({ table: "measurement", row, expiresAt: expiry(row.deletedAt) })),
    ...db.select().from(photo).where(isNotNull(photo.deletedAt)).all().map((row): TrashItem => ({ table: "photo", row, expiresAt: expiry(row.deletedAt) })),
    ...db.select().from(checkIn).where(isNotNull(checkIn.deletedAt)).all().map((row): TrashItem => ({ table: "check_in", row, expiresAt: expiry(row.deletedAt) })),
    ...db.select().from(painReport).where(isNotNull(painReport.deletedAt)).all().map((row): TrashItem => ({ table: "pain_report", row, expiresAt: expiry(row.deletedAt) })),
  ];
  return items.sort((left, right) => (right.row.deletedAt ?? 0) - (left.row.deletedAt ?? 0));
}

export function restoreMutation(item: TrashItem): Mutation {
  return { kind: "update", table: item.table, key: item.row.id, patch: { deletedAt: null } } as Mutation;
}

export type RestoreBlocker = "day_taken" | "session_open" | "zone_taken";

export function restoreBlocker(db: ObnixeDatabase, item: TrashItem): RestoreBlocker | null {
  switch (item.table) {
    case "session": {
      if (item.row.status === "completed") return null;
      const open = db.select({ id: session.id }).from(session).where(and(isNull(session.deletedAt), ne(session.status, "completed"))).get();
      return open === undefined ? null : "session_open";
    }
    case "weigh_in":
      return db.select({ id: weighIn.id, deletedAt: weighIn.deletedAt }).from(weighIn).where(eq(weighIn.localDate, item.row.localDate)).all().some((row) => row.deletedAt === null) ? "day_taken" : null;
    case "measurement":
      return db
        .select({ deletedAt: measurement.deletedAt })
        .from(measurement)
        .where(and(eq(measurement.kindId, item.row.kindId), eq(measurement.localDate, item.row.localDate)))
        .all()
        .some((row) => row.deletedAt === null)
        ? "day_taken"
        : null;
    case "check_in":
      return db.select({ deletedAt: checkIn.deletedAt }).from(checkIn).where(eq(checkIn.localDate, item.row.localDate)).all().some((row) => row.deletedAt === null) ? "day_taken" : null;
    case "pain_report": {
      const checkInId = item.row.checkInId;
      if (checkInId === null) return null;
      return db
        .select({ deletedAt: painReport.deletedAt })
        .from(painReport)
        .where(and(eq(painReport.checkInId, checkInId), eq(painReport.zone, item.row.zone)))
        .all()
        .some((row) => row.deletedAt === null)
        ? "zone_taken"
        : null;
    }
    case "photo":
      return null;
    default: {
      const unreachable: never = item;
      throw new Error(`Unhandled trash item ${JSON.stringify(unreachable)}`);
    }
  }
}

export interface PurgeTarget {
  readonly table: JournaledTable;
  readonly row: RowImage;
}

export interface PurgeRelease {
  readonly table: JournaledTable;
  readonly id: string;
  readonly patch: Record<string, null>;
}

export interface PurgePlan {
  readonly releases: readonly PurgeRelease[];
  readonly deletions: readonly PurgeTarget[];
  readonly photoFiles: readonly string[];
}

export interface PurgeResult {
  readonly purgedRows: number;
  readonly photoFiles: readonly string[];
}

const tableOrder = new Map<JournaledTable, number>(journaledTables.map((table, index) => [table, index]));

function referencing(db: ObnixeDatabase, table: JournaledTable, id: string, column: string): readonly RowImage[] {
  const target = journaled[table] as SQLiteTable;
  const columnRef = getTableColumns(target)[column] as SQLiteColumn;
  return db.select().from(target).where(eq(columnRef, id)).all() as RowImage[];
}

interface Closure {
  readonly deletes: Map<string, PurgeTarget>;
  readonly releases: Map<string, PurgeRelease>;
}

function collect(db: ObnixeDatabase, root: PurgeTarget): Closure | null {
  const deletes = new Map<string, PurgeTarget>();
  const pending: PurgeTarget[] = [root];
  const softReferences: { readonly table: JournaledTable; readonly row: RowImage; readonly column: string; readonly restrict: boolean }[] = [];
  while (pending.length > 0) {
    const current = pending.pop() as PurgeTarget;
    const key = `${current.table}:${String(current.row.id)}`;
    if (deletes.has(key)) continue;
    deletes.set(key, current);
    for (const foreignKey of foreignKeysTo(current.table)) {
      for (const row of referencing(db, foreignKey.table, String(current.row.id), foreignKey.column)) {
        if (foreignKey.onDelete === "cascade") pending.push({ table: foreignKey.table, row });
        else softReferences.push({ table: foreignKey.table, row, column: foreignKey.column, restrict: foreignKey.onDelete === "restrict" });
      }
    }
  }
  const releases: Closure["releases"] = new Map();
  for (const reference of softReferences) {
    const key = `${reference.table}:${String(reference.row.id)}`;
    if (deletes.has(key)) continue;
    if (reference.restrict) return null;
    const existing = releases.get(key);
    releases.set(key, { table: reference.table, id: String(reference.row.id), patch: { ...(existing?.patch ?? {}), [reference.column]: null } });
  }
  return { deletes, releases };
}

function expiredRoots(db: ObnixeDatabase, cutoff: EpochMs): readonly PurgeTarget[] {
  const roots: PurgeTarget[] = [];
  const add = (table: JournaledTable, rows: readonly RowImage[]): void => {
    for (const row of rows) roots.push({ table, row });
  };
  add("session", db.select().from(session).where(lt(session.deletedAt, cutoff)).all());
  add("weigh_in", db.select().from(weighIn).where(lt(weighIn.deletedAt, cutoff)).all());
  add("measurement", db.select().from(measurement).where(lt(measurement.deletedAt, cutoff)).all());
  add("photo", db.select().from(photo).where(lt(photo.deletedAt, cutoff)).all());
  add("check_in", db.select().from(checkIn).where(lt(checkIn.deletedAt, cutoff)).all());
  add("pain_report", db.select().from(painReport).where(lt(painReport.deletedAt, cutoff)).all());
  return roots;
}

export function planTrashPurge(db: ObnixeDatabase, now: EpochMs): PurgePlan {
  const deletes = new Map<string, PurgeTarget>();
  const releases: Closure["releases"] = new Map();
  for (const root of expiredRoots(db, (now - trashRetentionMs) as EpochMs)) {
    const closure = collect(db, root);
    if (closure === null) continue;
    for (const [key, target] of closure.deletes) deletes.set(key, target);
    for (const [key, release] of closure.releases) releases.set(key, { ...release, patch: { ...(releases.get(key)?.patch ?? {}), ...release.patch } });
  }
  const deletions = [...deletes.values()].sort((left, right) => (tableOrder.get(right.table) ?? 0) - (tableOrder.get(left.table) ?? 0));
  const photoFiles = deletions.filter((target) => target.table === "photo").map((target) => String(target.row.file));
  return { releases: [...releases].filter(([key]) => !deletes.has(key)).map(([, release]) => release), deletions, photoFiles };
}

/**
 * Permanently deletes expired trash outside the journal, together with every recorded change of the
 * deleted rows: nothing of them survives, and the purge itself cannot be undone. Changesets left
 * without any change are dropped. Released references are not journaled either, so older changes on
 * those rows conflict on revert instead of resurrecting a dangling reference.
 */
export function purgeExpiredTrash(db: ObnixeDatabase, env: Environment): PurgeResult {
  const plan = planTrashPurge(db, env.now());
  if (plan.deletions.length === 0) return { purgedRows: 0, photoFiles: [] };
  const now = env.now();
  db.transaction((tx) => {
    for (const release of plan.releases) {
      const target = journaled[release.table] as SQLiteTable;
      const patch: RowImage = "updatedAt" in getTableColumns(target) ? { ...release.patch, updatedAt: now } : release.patch;
      tx.update(target).set(patch).where(keyCondition(release.table, release.id)).run();
    }
    for (const deletion of plan.deletions) {
      tx.delete(journaled[deletion.table] as SQLiteTable)
        .where(keyCondition(deletion.table, rowKey(deletion.table, deletion.row)))
        .run();
    }
    forgetHistory(tx, plan.deletions);
  });
  return { purgedRows: plan.deletions.length, photoFiles: plan.photoFiles };
}

function forgetHistory(db: ObnixeDatabase, targets: readonly PurgeTarget[]): void {
  const touched = new Set<Id>();
  for (const target of targets) {
    const recorded = and(eq(change.tableName, target.table), eq(change.rowId, rowKey(target.table, target.row)));
    for (const row of db.select({ changesetId: change.changesetId }).from(change).where(recorded).all()) touched.add(row.changesetId);
    db.delete(change).where(recorded).run();
  }
  const emptied = [...touched].filter((changesetId) => db.select({ one: sql<number>`1` }).from(change).where(eq(change.changesetId, changesetId)).limit(1).get() === undefined);
  if (emptied.length === 0) return;
  db.update(agentCall).set({ changesetId: null }).where(inArray(agentCall.changesetId, emptied)).run();
  db.delete(changeset).where(inArray(changeset.id, emptied)).run();
}

export function replacedSnapshots(db: ObnixeDatabase): readonly Backup[] {
  return db
    .select()
    .from(backup)
    .where(and(eq(backup.kind, "import_replace"), isNotNull(backup.snapshotFile)))
    .orderBy(desc(backup.createdAt))
    .all();
}

export function expiredReplacedSnapshots(db: ObnixeDatabase, now: EpochMs): readonly Backup[] {
  return replacedSnapshots(db).filter((row) => row.createdAt < now - trashRetentionMs);
}
