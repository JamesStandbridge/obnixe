import { sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { changeset, journaled, journaledTables, settings } from "@obnixe/schema";
import type { Id, RowImage } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../../database.ts";
import type { Snapshot } from "./snapshot.ts";

export const replaceSummary = "Remplacement par une sauvegarde";

/**
 * Wipes every journaled table and loads the snapshot in one transaction. This is not undoable through
 * the journal: callers keep a snapshot of the replaced data to offer a restore instead. The journal is
 * kept; older changesets simply conflict if someone tries to revert them against the new rows.
 */
export function replaceWithSnapshot(db: ObnixeDatabase, env: Environment, snapshot: Snapshot): Id {
  const changesetId = env.newId();
  const now = env.now();
  db.transaction((tx) => {
    tx.run(sql`PRAGMA defer_foreign_keys = ON`);
    for (const table of [...journaledTables].reverse()) tx.delete(journaled[table] as SQLiteTable).run();
    tx.insert(changeset).values({ id: changesetId, author: "import", connectionId: null, summary: replaceSummary, revertsId: null, createdAt: now }).run();
    for (const table of journaledTables) {
      const target = journaled[table] as SQLiteTable;
      for (const row of snapshot.tables[table] as readonly RowImage[]) {
        tx.insert(target)
          .values(table === "program_version" ? { ...row, changesetId } : row)
          .run();
      }
    }
    tx.update(settings).set({ ...snapshot.settings, updatedAt: now }).run();
  });
  return changesetId;
}
