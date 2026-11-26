import { asc, eq } from "drizzle-orm";
import { decodeTrack, exportActivity, exportFileName, exportMimeTypes, exportPrivacyMask, processTrack, resolveProfile, retrimmedLaps } from "@obnixe/core";
import type { ExportFormat, PrivacyMask } from "@obnixe/core";
import { lap, recording, session } from "@obnixe/schema";
import type { EpochMs, Id } from "@obnixe/schema";
import { db } from "@/data/database";
import { readTrack } from "@/features/tracking/trackStore";

export interface ExportedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly startedAt: EpochMs;
}

/** The session has no track file, or the file is gone: « Trace indisponible ». */
export class TrackUnavailableError extends Error {
  constructor(readonly sessionId: Id) {
    super(`Session ${sessionId} has no readable track`);
  }
}

/**
 * `IO-001` to `IO-004`: the fixes kept by stages 2 and 3 inside the trim, named `obnixe-YYYY-MM-DD-<title>.<format>`, masked
 * by `mask`.
 */
export async function maskedActivityFile(sessionId: Id, format: ExportFormat, mask: PrivacyMask | null): Promise<ExportedFile> {
  const found = db().select({ session, recording }).from(session).innerJoin(recording, eq(recording.sessionId, session.id)).where(eq(session.id, sessionId)).get();
  const file = found?.recording.trackFile ?? null;
  if (found === undefined || file === null) throw new TrackUnavailableError(sessionId);
  const bytes = await readTrack(file);
  if (bytes === null) throw new TrackUnavailableError(sessionId);
  const track = decodeTrack(bytes);
  const { sport, values, title, startedAt, timeZone } = found.session;
  const trim = { startMs: found.recording.trimStartMs, endMs: found.recording.trimEndMs };
  const profile = resolveProfile(sport, values);
  const laps = db().select().from(lap).where(eq(lap.sessionId, sessionId)).orderBy(asc(lap.position)).all();
  const processed = profile === null ? null : processTrack(track, profile, { laps: { kind: "given", laps: retrimmedLaps(laps, trim, trim) }, trim });
  return {
    name: exportFileName({ startedAt, timeZone, title, sport }, format),
    bytes: exportActivity({ track, processed, trim, sport, values, title, mask, energyKcal: found.recording.energyKcal }, format),
    mimeType: exportMimeTypes[format],
    startedAt,
  };
}

/** The privacy zones apply unless the user includes the full track (`PRV-011`). */
export async function activityFile(sessionId: Id, format: ExportFormat, includeFullTrack: boolean): Promise<ExportedFile> {
  return maskedActivityFile(sessionId, format, exportPrivacyMask(db(), includeFullTrack));
}
