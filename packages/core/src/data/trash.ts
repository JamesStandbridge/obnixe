import { and, desc, eq, getTableColumns, isNotNull, isNull, lt, ne } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { backup, checkIn, journaled, journaledTables, measurement, painReport, photo, session, weighIn } from "@obnixe/schema";
import type { Backup, CheckIn, EpochMs, Id, JournaledTable, Measurement, PainReport, Photo, RowImage, Session, WeighIn } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import { commit } from "../writer.ts";
import type { Actor, Mutation } from "../writer.ts";
import { foreignKeysTo } from "./foreignKeys.ts";

export const trashRetentionMs = 30 * 86_400_000;

export const systemActor: Actor = { author: "system", connectionId: null };
export const purgeSummary = "Corbeille vidée après 30 jours";

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

export interface PurgePlan {
  readonly mutations: readonly Mutation[];
  readonly photoFiles: readonly string[];
}

export interface PurgeResult {
  readonly changesetId: Id | null;
  readonly photoFiles: readonly string[];
}

interface Target {
  readonly table: JournaledTable;
  readonly row: RowImage;
}

const tableOrder = new Map<JournaledTable, number>(journaledTables.map((table, index) => [table, index]));

function referencing(db: ObnixeDatabase, table: JournaledTable, id: string, column: string): readonly RowImage[] {
  const target = journaled[table] as SQLiteTable;
  const columnRef = getTableColumns(target)[column] as SQLiteColumn;
  return db.select().from(target).where(eq(columnRef, id)).all() as RowImage[];
}

interface Closure {
  readonly deletes: Map<string, Target>;
  readonly releases: Map<string, { readonly table: JournaledTable; readonly id: string; readonly patch: Record<string, null> }>;
}

function collect(db: ObnixeDatabase, root: Target): Closure | null {
  const deletes = new Map<string, Target>();
  const pending: Target[] = [root];
  const softReferences: { readonly table: JournaledTable; readonly row: RowImage; readonly column: string; readonly restrict: boolean }[] = [];
  while (pending.length > 0) {
    const current = pending.pop() as Target;
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

function expiredRoots(db: ObnixeDatabase, cutoff: EpochMs): readonly Target[] {
  const roots: Target[] = [];
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
  const deletes = new Map<string, Target>();
  const releases: Closure["releases"] = new Map();
  for (const root of expiredRoots(db, (now - trashRetentionMs) as EpochMs)) {
    const closure = collect(db, root);
    if (closure === null) continue;
    for (const [key, target] of closure.deletes) deletes.set(key, target);
    for (const [key, release] of closure.releases) releases.set(key, { ...release, patch: { ...(releases.get(key)?.patch ?? {}), ...release.patch } });
  }
  const updates: Mutation[] = [...releases]
    .filter(([key]) => !deletes.has(key))
    .map(([, release]) => ({ kind: "update", table: release.table, key: release.id, patch: release.patch }) as Mutation);
  const removals: Mutation[] = [...deletes.values()]
    .sort((left, right) => (tableOrder.get(right.table) ?? 0) - (tableOrder.get(left.table) ?? 0))
    .map((target) => ({ kind: "delete", table: target.table, key: String(target.row.id) }) as Mutation);
  const photoFiles = [...deletes.values()].filter((target) => target.table === "photo").map((target) => String(target.row.file));
  return { mutations: [...updates, ...removals], photoFiles };
}

export function purgeExpiredTrash(db: ObnixeDatabase, env: Environment): PurgeResult {
  const plan = planTrashPurge(db, env.now());
  if (plan.mutations.length === 0) return { changesetId: null, photoFiles: [] };
  const changesetId = commit(db, env, { actor: systemActor, summary: purgeSummary, revertsId: null, mutations: plan.mutations });
  return { changesetId, photoFiles: plan.photoFiles };
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
