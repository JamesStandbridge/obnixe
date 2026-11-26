import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { recording, route, session } from "@obnixe/schema";
import type { Id, Recording } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import type { Mutation } from "../writer.ts";
import type { SessionRecording, StoredTrack } from "./plans.ts";

/** What the launch reconciliation (annex C, `REC-082`) does with the raw journal of `sessionId`. */
export type JournalDisposition =
  /** No live recording of that session survives: an aborted start or a discard whose undo expired. */
  | { readonly kind: "orphan" }
  /** `in_progress` or `interrupted`: recovered by the recorder. */
  | { readonly kind: "open"; readonly live: SessionRecording }
  /** Saved: the journal goes once the track file is verified, or after it is rebuilt from the journal. */
  | { readonly kind: "saved"; readonly recording: Recording };

export function journalDisposition(db: ObnixeDatabase, sessionId: Id): JournalDisposition {
  const found = db.select({ session, recording }).from(session).innerJoin(recording, eq(recording.sessionId, session.id)).where(eq(session.id, sessionId)).get();
  if (found === undefined || found.recording.source === "import") return { kind: "orphan" };
  return found.session.status === "completed" ? { kind: "saved", recording: found.recording } : { kind: "open", live: found };
}

/** The open session that carries a phone recording, with or without location, if any; trashed sessions never are. */
export function openLiveRecording(db: ObnixeDatabase): SessionRecording | null {
  return (
    db
      .select({ session, recording })
      .from(session)
      .innerJoin(recording, eq(recording.sessionId, session.id))
      .where(and(ne(session.status, "completed"), isNull(session.deletedAt), ne(recording.source, "import")))
      .get() ?? null
  );
}

/** Track files of every recording and route row, trashed ones included: any other `.otrk` file is an orphan. */
export function referencedTrackFiles(db: ObnixeDatabase): ReadonlySet<string> {
  const rows = db.select({ file: recording.trackFile }).from(recording).where(isNotNull(recording.trackFile)).all();
  const routes = db.select({ file: route.trackFile }).from(route).all();
  return new Set([...rows.flatMap((row) => (row.file === null ? [] : [row.file])), ...routes.map((row) => row.file)]);
}

/** « Trace reconstruite »: a saved recording whose track file was lost points to the one rebuilt from its journal. */
export function trackRebuildMutations(row: Recording, stored: StoredTrack): readonly Mutation[] {
  return [{ kind: "update", table: "recording", key: row.id, patch: { trackFile: stored.file, trackSha256: stored.sha256, trackBytes: stored.bytes } }];
}
