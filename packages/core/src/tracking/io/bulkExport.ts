import { and, asc, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { Zip, ZipDeflate } from "fflate";
import type { FlateError } from "fflate";
import { recording, session } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate } from "@obnixe/schema";
import type { ObnixeDatabase } from "../../database.ts";

export const archiveMimeType = "application/zip";

/** ZIP entry dates are MS-DOS dates; an entry outside them gets the time of the export. */
const zipDateRange = { startMs: Date.UTC(1980, 0, 2), endMs: Date.UTC(2099, 11, 31) } as const;

export interface ExportableSession {
  readonly sessionId: Id;
  readonly startedAt: EpochMs;
}

export class ArchiveWriteError extends Error {
  constructor(error: FlateError) {
    super(`The archive cannot be written: ${error.message}`);
  }
}

/** The live sessions with a track file, oldest first, from the local date `since` when given (`IO-005`). */
export function exportableSessions(db: ObnixeDatabase, since: LocalDate | null): readonly ExportableSession[] {
  return db
    .select({ sessionId: session.id, startedAt: session.startedAt })
    .from(session)
    .innerJoin(recording, eq(recording.sessionId, session.id))
    .where(and(isNull(session.deletedAt), isNotNull(recording.trackFile), since === null ? undefined : gte(session.localDate, since)))
    .orderBy(asc(session.startedAt))
    .all();
}

/** `obnixe-activites-YYYY-MM-DD.zip`, the local date of the export. */
export function archiveFileName(date: LocalDate): string {
  return `obnixe-activites-${date}.zip`;
}

/**
 * A ZIP archive written as a stream (`IO-005`): each file is compressed when it is added, and `take` hands over the bytes
 * produced so far, so that only the file being added is held in memory. Names already used get a `-2`, `-3` suffix.
 */
export class ExportArchive {
  private readonly zip: Zip;
  private readonly names = new Set<string>();
  private chunks: Uint8Array[] = [];
  private failure: FlateError | null = null;

  constructor() {
    this.zip = new Zip((error, chunk) => {
      if (error !== null) this.failure = error;
      else this.chunks.push(chunk);
    });
  }

  /** Adds a file and returns the name it has in the archive. */
  add(name: string, bytes: Uint8Array, modifiedAt: EpochMs): string {
    const unique = this.uniqueName(name);
    const entry = new ZipDeflate(unique, { level: 6 });
    if (modifiedAt >= zipDateRange.startMs && modifiedAt < zipDateRange.endMs) entry.mtime = modifiedAt;
    this.zip.add(entry);
    entry.push(bytes, true);
    return unique;
  }

  /** Writes the central directory: `take` then returns the end of the archive. */
  end(): void {
    this.zip.end();
  }

  take(): readonly Uint8Array[] {
    if (this.failure !== null) throw new ArchiveWriteError(this.failure);
    const taken = this.chunks;
    this.chunks = [];
    return taken;
  }

  private uniqueName(name: string): string {
    const dot = name.lastIndexOf(".");
    const stem = dot <= 0 ? name : name.slice(0, dot);
    const extension = dot <= 0 ? "" : name.slice(dot);
    let candidate = name;
    for (let suffix = 2; this.names.has(candidate); suffix += 1) candidate = `${stem}-${suffix}${extension}`;
    this.names.add(candidate);
    return candidate;
  }
}
