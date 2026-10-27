import { and, asc, desc, eq, lt } from "drizzle-orm";
import { change, changeset, planRevert, programItem, programSlot, programVariant, programVersion } from "@obnixe/schema";
import type { Id, JournaledTable, ProgramVersion, RevertConflict, RevertOperation, RowImage } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "./database.ts";
import { rowKey } from "./keys.ts";
import { DependentRowsError, commit, readRow } from "./writer.ts";
import type { Actor, Mutation, NewRow } from "./writer.ts";

export class RevertConflictError extends Error {
  constructor(readonly conflicts: readonly RevertConflict[]) {
    super(`Revert blocked by later changes on ${conflicts.map((conflict) => `${conflict.table} ${conflict.rowId}`).join(", ")}`);
  }
}

export class AlreadyRevertedError extends Error {
  constructor(readonly changesetId: Id, readonly revertedBy: Id) {
    super(`Changeset ${changesetId} was already reverted by ${revertedBy}`);
  }
}

export class ChangesetNotFoundError extends Error {
  constructor(readonly changesetId: Id) {
    super(`Changeset ${changesetId} does not exist`);
  }
}

export interface RevertRequest {
  readonly actor: Actor;
  readonly changesetId: Id;
  readonly summary: string;
  readonly restoredVersionSummary: (restoredNumber: number) => string;
}

interface ChainLink {
  readonly revertsId: Id | null;
  readonly companionId: Id | null;
}

function chainLink(db: ObnixeDatabase, changesetId: Id): ChainLink {
  const link = db.select({ revertsId: changeset.revertsId, companionId: changeset.companionId }).from(changeset).where(eq(changeset.id, changesetId)).get();
  if (link === undefined) throw new ChangesetNotFoundError(changesetId);
  return link;
}

function revertedBy(db: ObnixeDatabase, changesetId: Id): Id | null {
  return db.select({ id: changeset.id }).from(changeset).where(eq(changeset.revertsId, changesetId)).get()?.id ?? null;
}

interface ChainPosition {
  readonly companionId: Id | null;
  /** Reverts chained between the original changeset and this one: even while its effect is applied, odd while undone. */
  readonly depth: number;
}

function chainPosition(db: ObnixeDatabase, changesetId: Id): ChainPosition {
  let link = chainLink(db, changesetId);
  let depth = 0;
  while (link.revertsId !== null) {
    link = chainLink(db, link.revertsId);
    depth += 1;
  }
  return { companionId: link.companionId, depth };
}

interface ChainTip {
  readonly tipId: Id;
  readonly depth: number;
}

function chainTip(db: ObnixeDatabase, changesetId: Id): ChainTip {
  let tipId = changesetId;
  let depth = 0;
  let next = revertedBy(db, tipId);
  while (next !== null) {
    tipId = next;
    depth += 1;
    next = revertedBy(db, tipId);
  }
  return { tipId, depth };
}

/**
 * Reverts a changeset in a single transaction. When its original changeset has a companion (rows it needs), undoing
 * also undoes the companion afterwards unless that revert conflicts, in which case the companion rows stay; redoing
 * restores an undone companion first, since the redone rows need it.
 */
export function revert(db: ObnixeDatabase, env: Environment, request: RevertRequest): Id {
  return db.transaction((tx) => {
    const position = chainPosition(tx, request.changesetId);
    if (position.companionId === null) return revertOne(tx, env, request, request.changesetId);
    const companion = chainTip(tx, position.companionId);
    const companionApplied = companion.depth % 2 === 0;
    if (position.depth % 2 === 1) {
      if (!companionApplied) revertOne(tx, env, request, companion.tipId);
      return revertOne(tx, env, request, request.changesetId);
    }
    const reverted = revertOne(tx, env, request, request.changesetId);
    if (companionApplied) {
      try {
        revertOne(tx, env, request, companion.tipId);
      } catch (error) {
        if (!(error instanceof RevertConflictError)) throw error;
      }
    }
    return reverted;
  });
}

function revertOne(db: ObnixeDatabase, env: Environment, request: RevertRequest, changesetId: Id): Id {
  const target = db.select().from(changeset).where(eq(changeset.id, changesetId)).get();
  if (target === undefined) throw new ChangesetNotFoundError(changesetId);
  const existing = revertedBy(db, changesetId);
  if (existing !== null) throw new AlreadyRevertedError(changesetId, existing);
  const changes = db.select().from(change).where(eq(change.changesetId, changesetId)).orderBy(asc(change.sequence)).all();
  const plan = planRevert(changes, (table, rowId) => readRow(db, table, rowId));
  if (plan.conflicts.length > 0) throw new RevertConflictError(plan.conflicts);
  const mutations = plan.operations.flatMap((operation) => toMutations(db, env, request, operation));
  try {
    return commit(db, env, { actor: request.actor, summary: request.summary, revertsId: changesetId, mutations });
  } catch (error) {
    if (error instanceof DependentRowsError) throw new RevertConflictError([{ table: error.table, rowId: error.key }]);
    throw error;
  }
}

function toMutations(db: ObnixeDatabase, env: Environment, request: RevertRequest, operation: RevertOperation): Mutation[] {
  switch (operation.kind) {
    case "insert":
      return [{ kind: "insert", table: operation.table, row: stripManaged(operation.row) } as Mutation];
    case "update":
      return [{ kind: "update", table: operation.table, key: operation.rowId, patch: stripManaged(operation.row) } as Mutation];
    case "delete":
      return [{ kind: "delete", table: operation.table, key: operation.rowId } as Mutation];
    case "restore_previous_version":
      return restorePreviousVersion(db, env, request, operation.versionId as Id);
    default: {
      const unreachable: never = operation;
      throw new Error(`Unhandled revert operation ${JSON.stringify(unreachable)}`);
    }
  }
}

function stripManaged(row: RowImage): RowImage {
  const { updatedAt: _updatedAt, changesetId: _changesetId, ...rest } = row;
  return rest;
}

function restorePreviousVersion(db: ObnixeDatabase, env: Environment, request: RevertRequest, versionId: Id): Mutation[] {
  const reverted = db.select().from(programVersion).where(eq(programVersion.id, versionId)).get();
  if (reverted === undefined) throw new RevertConflictError([{ table: "program_version", rowId: versionId }]);
  const latest = db
    .select({ number: programVersion.number })
    .from(programVersion)
    .where(eq(programVersion.programId, reverted.programId))
    .orderBy(desc(programVersion.number))
    .get();
  if (latest !== undefined && latest.number !== reverted.number) {
    throw new RevertConflictError([{ table: "program_version", rowId: versionId }]);
  }
  const previous = db
    .select()
    .from(programVersion)
    .where(and(eq(programVersion.programId, reverted.programId), lt(programVersion.number, reverted.number)))
    .orderBy(desc(programVersion.number))
    .get();
  return previous === undefined ? deleteVersionTree(db, reverted) : copyVersionTree(db, env, request, reverted, previous);
}

function deleteVersionTree(db: ObnixeDatabase, version: ProgramVersion): Mutation[] {
  const mutations: Mutation[] = [];
  const remove = (table: JournaledTable, row: RowImage): void => {
    mutations.push({ kind: "delete", table, key: rowKey(table, row) } as Mutation);
  };
  for (const slot of db.select().from(programSlot).where(eq(programSlot.versionId, version.id)).all()) {
    for (const variant of db.select().from(programVariant).where(eq(programVariant.slotId, slot.id)).all()) {
      for (const item of db.select().from(programItem).where(eq(programItem.variantId, variant.id)).all()) remove("program_item", item);
      remove("program_variant", variant);
    }
    remove("program_slot", slot);
  }
  remove("program_version", version);
  return mutations;
}

function copyVersionTree(db: ObnixeDatabase, env: Environment, request: RevertRequest, reverted: ProgramVersion, source: ProgramVersion): Mutation[] {
  const versionId = env.newId();
  const version: NewRow<"program_version"> = {
    id: versionId,
    programId: source.programId,
    number: reverted.number + 1,
    name: source.name,
    sessionsPerWeek: source.sessionsPerWeek,
    copiedFromId: source.id,
    summary: request.restoredVersionSummary(source.number),
    reason: null,
  };
  const mutations: Mutation[] = [{ kind: "insert", table: "program_version", row: version }];
  for (const slot of db.select().from(programSlot).where(eq(programSlot.versionId, source.id)).all()) {
    const slotId = env.newId();
    mutations.push({ kind: "insert", table: "program_slot", row: { ...slot, id: slotId, versionId } });
    for (const variant of db.select().from(programVariant).where(eq(programVariant.slotId, slot.id)).all()) {
      const variantId = env.newId();
      mutations.push({ kind: "insert", table: "program_variant", row: { ...variant, id: variantId, slotId } });
      for (const item of db.select().from(programItem).where(eq(programItem.variantId, variant.id)).all()) {
        mutations.push({ kind: "insert", table: "program_item", row: { ...item, id: env.newId(), variantId } });
      }
    }
  }
  return mutations;
}
