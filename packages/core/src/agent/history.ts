import { eq, isNotNull } from "drizzle-orm";
import { change, changeset } from "@obnixe/schema";
import type { Id } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import { revert } from "../undo.ts";
import type { Actor } from "../writer.ts";

export interface RevertLink {
  readonly id: Id;
  readonly revertsId: Id | null;
}

export interface RevertState {
  readonly reverted: boolean;
  readonly tipId: Id;
}

export type RevertIndex = ReadonlyMap<Id, Id>;

export function revertIndex(links: readonly RevertLink[]): RevertIndex {
  const index = new Map<Id, Id>();
  for (const link of links) if (link.revertsId !== null) index.set(link.revertsId, link.id);
  return index;
}

/** A change is reverted when an odd number of reverts are chained after it; the tip is the changeset to revert next to toggle it. */
export function revertState(index: RevertIndex, changesetId: Id): RevertState {
  let tipId = changesetId;
  let depth = 0;
  for (let next = index.get(tipId); next !== undefined; next = index.get(tipId)) {
    tipId = next;
    depth += 1;
  }
  return { reverted: depth % 2 === 1, tipId };
}

export function loadRevertIndex(db: ObnixeDatabase): RevertIndex {
  return revertIndex(db.select({ id: changeset.id, revertsId: changeset.revertsId }).from(changeset).where(isNotNull(changeset.revertsId)).all());
}

export interface ToggleResult {
  readonly reverted: boolean;
  readonly changesetId: Id;
  readonly publishedVersion: boolean;
}

export function toggleChange(db: ObnixeDatabase, env: Environment, actor: Actor, changesetId: Id, summary: string): ToggleResult {
  const state = revertState(loadRevertIndex(db), changesetId);
  const reverted = !state.reverted;
  const created = revert(db, env, {
    actor,
    changesetId: state.tipId,
    summary: reverted ? `Annulation : ${summary}` : `Rétablissement : ${summary}`,
    restoredVersionSummary: (restoredNumber) => `Retour à la v${restoredNumber}`,
  });
  const publishedVersion = db
    .select({ table: change.tableName, operation: change.operation })
    .from(change)
    .where(eq(change.changesetId, created))
    .all()
    .some((row) => row.table === "program_version" && row.operation === "insert");
  return { reverted, changesetId: created, publishedVersion };
}
