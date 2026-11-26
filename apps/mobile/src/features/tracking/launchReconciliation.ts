import { encodeTrack, journalDisposition, referencedTrackFiles, trackDigest, trackRebuildMutations } from "@obnixe/core";
import type { EpochMs, Recording } from "@obnixe/schema";
import { db } from "@/data/database";
import { journalTrackOf } from "@/features/tracking/journalFeed";
import type { RecorderWriter } from "@/features/tracking/recorderHost";
import { deleteJournal, deleteTrack, journalSessionIds, readJournalFile, readTrack, storedTrackFiles, sweepTemporaryTracks, writeTrack } from "@/features/tracking/trackStore";

export interface ReconciliationReport {
  readonly deletedJournals: number;
  readonly rebuiltTracks: number;
  readonly deletedTracks: number;
}

async function hasValidTrack(row: Recording): Promise<boolean> {
  if (row.trackFile === null) return false;
  const bytes = await readTrack(row.trackFile);
  return bytes !== null && trackDigest(bytes) === row.trackSha256;
}

/** « Trace reconstruite »: the saved session lost its track, its raw journal still has it. */
async function rebuildTrack(writer: Pick<RecorderWriter, "write">, row: Recording, bytes: Uint8Array): Promise<boolean> {
  const { header, track } = journalTrackOf(bytes, 0 as EpochMs);
  if (header === null) return false;
  const stored = await writeTrack(row.id, encodeTrack(track));
  writer.write("Trace reconstruite", trackRebuildMutations(row, stored));
  return true;
}

/**
 * Annex C, run before the tabs show and idempotent (`REC-082`): temporary tracks go, each raw journal is settled against
 * its session (open ones are left to the recorder recovery), and track files no row references go, the trash included.
 */
export async function reconcileRecordingFiles(writer: Pick<RecorderWriter, "write">): Promise<ReconciliationReport> {
  await sweepTemporaryTracks();
  let deletedJournals = 0;
  let rebuiltTracks = 0;
  for (const sessionId of await journalSessionIds()) {
    const disposition = journalDisposition(db(), sessionId);
    switch (disposition.kind) {
      case "open":
        continue;
      case "saved": {
        const bytes = await readJournalFile(sessionId);
        if (bytes !== null && !(await hasValidTrack(disposition.recording)) && (await rebuildTrack(writer, disposition.recording, bytes))) rebuiltTracks += 1;
        break;
      }
      case "orphan":
        break;
      default: {
        const unreachable: never = disposition;
        throw new Error(`Unhandled journal disposition ${JSON.stringify(unreachable)}`);
      }
    }
    await deleteJournal(sessionId);
    deletedJournals += 1;
  }
  const referenced = referencedTrackFiles(db());
  let deletedTracks = 0;
  for (const file of await storedTrackFiles()) {
    if (referenced.has(file)) continue;
    await deleteTrack(file);
    deletedTracks += 1;
  }
  return { deletedJournals, rebuiltTracks, deletedTracks };
}
