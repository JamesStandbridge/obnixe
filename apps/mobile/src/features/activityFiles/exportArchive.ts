import { addDays, dateParts, ExportArchive, exportPrivacyMask, localDate, TrackDecodeError } from "@obnixe/core";
import type { ExportableSession, ExportFormat } from "@obnixe/core";
import type { LocalDate } from "@obnixe/schema";
import { db } from "@/data/database";
import { maskedActivityFile, TrackUnavailableError } from "@/features/activityFiles/exportActivity";
import type { StreamedFile } from "@/features/data/files";

export const bulkExportFormats = ["gpx", "fit"] as const satisfies readonly ExportFormat[];
export type BulkExportFormat = (typeof bulkExportFormats)[number];

export const exportPeriods = ["all", "year", "twelveMonths", "thirtyDays"] as const;
export type ExportPeriod = (typeof exportPeriods)[number];

/** The first local date of the period ending `today`, `null` for every activity. */
export function periodStart(period: ExportPeriod, today: LocalDate): LocalDate | null {
  switch (period) {
    case "all":
      return null;
    case "year":
      return localDate(dateParts(today).year, 1, 1);
    case "twelveMonths":
      return addDays(today, -364);
    case "thirtyDays":
      return addDays(today, -29);
    default: {
      const unreachable: never = period;
      throw new Error(`Unhandled period ${String(unreachable)}`);
    }
  }
}

export interface BulkExportResult {
  readonly exported: number;
  /** Sessions whose track file is gone or unreadable. */
  readonly skipped: number;
}

/**
 * `IO-005`: one file per session, masked like a single export (`PRV-011`), compressed and written to `file` before the next
 * session is read.
 */
export async function writeExportArchive(sessions: readonly ExportableSession[], format: BulkExportFormat, includeFullTrack: boolean, file: StreamedFile, onProgress: (done: number) => void): Promise<BulkExportResult> {
  const archive = new ExportArchive();
  const mask = exportPrivacyMask(db(), includeFullTrack);
  let exported = 0;
  let skipped = 0;
  for (const [index, row] of sessions.entries()) {
    try {
      const activity = await maskedActivityFile(row.sessionId, format, mask);
      archive.add(activity.name, activity.bytes, activity.startedAt);
      await file.write(archive.take());
      exported += 1;
    } catch (error) {
      if (!(error instanceof TrackUnavailableError || error instanceof TrackDecodeError)) throw error;
      skipped += 1;
    }
    onProgress(index + 1);
  }
  archive.end();
  await file.write(archive.take());
  return { exported, skipped };
}
