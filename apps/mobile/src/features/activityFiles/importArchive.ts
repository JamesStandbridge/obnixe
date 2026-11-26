import { z, ZodError } from "zod";
import { archiveImportApplied, archiveImportSummary, archiveSliceMs, importArchive, previewArchive, slicedPace, undoArchiveImport } from "@obnixe/core";
import type { Actor, ArchiveControl, ArchiveDuplicatePolicy, ArchiveErrorReason, ArchiveImportReport, ArchivePreview, ArchiveProgress, ArchiveRefusalReason, OpenedArchive } from "@obnixe/core";
import type { EpochMs, Id } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { deleteLocalState, readLocalState, writeLocalState } from "@/features/data/localState";
import { importErrorMessage } from "@/features/activityFiles/importActivity";
import { deleteTrack, writeTrack } from "@/features/tracking/trackStore";
import { deviceTimeZone } from "@/format/dates";

const userActor: Actor = { author: "user", connectionId: null };
const lastImportFile = "last-archive-import.json";

/** The last archive import of this device, so that the import screen still offers to undo it after its report (`IO-025`). */
export interface LastArchiveImport {
  readonly importedAt: EpochMs;
  readonly report: ArchiveImportReport;
}

const idSchema = z.custom<Id>((value) => typeof value === "string");
const lastImportSchema = z.object({
  importedAt: z.custom<EpochMs>((value) => typeof value === "number"),
  report: z.object({
    format: z.enum(["garmin_archive"]),
    imported: z.number(),
    replaced: z.number(),
    skipped: z.number(),
    refused: z.tuple([]),
    batches: z.array(z.object({ changesetId: idSchema, sessionIds: z.array(idSchema), trackFiles: z.array(z.string()) })),
    stopped: z.boolean(),
  }),
});

/** `IO-013` for an archive refused as a whole. */
export function archiveErrorMessage(reason: ArchiveErrorReason): string {
  switch (reason) {
    case "not_a_zip":
      return "Ce fichier n'est pas une archive ZIP";
    case "not_an_account_archive":
      return "Ce ZIP n'est pas l'export de compte Garmin Connect : il n'a pas de dossier DI_CONNECT";
    case "malformed":
      return "Archive abîmée, impossible à lire";
    case "truncated":
      return "Archive incomplète : le téléchargement s'est arrêté avant la fin";
    case "encrypted":
      return "Archive protégée par un mot de passe";
    case "unsupported_compression":
      return "Archive compressée d'une façon qu'Obnixe ne lit pas";
    case "checksum":
      return "Archive corrompue : la somme de contrôle ne correspond pas";
    case "too_large":
      return "Fichier trop grand pour être importé";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

/** Why one file of the archive is refused (`IO-020`). */
export function archiveRefusalMessage(reason: ArchiveRefusalReason): string {
  switch (reason) {
    case "not_a_zip":
    case "not_an_account_archive":
    case "encrypted":
    case "unsupported_compression":
    case "too_large":
      return archiveErrorMessage(reason);
    case "unsupported_format":
    case "malformed":
    case "checksum":
    case "truncated":
    case "not_an_activity":
    case "not_a_route":
    case "several_activities":
    case "no_activity_data":
    case "untimed":
    case "unordered_time":
    case "invalid_coordinates":
    case "invalid_value":
      return importErrorMessage(reason);
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

/** `IO-026`: the work yields to the interface every `archiveSliceMs`. */
export function archiveControl(stopped: () => boolean, onProgress: (progress: ArchiveProgress) => void): ArchiveControl {
  return { pace: slicedPace(() => performance.now(), archiveSliceMs), stopped, onProgress };
}

export function analyseArchive(archive: OpenedArchive, control: ArchiveControl): Promise<ArchivePreview> {
  return previewArchive(db(), archive, control);
}

export function importArchiveActivities(archive: OpenedArchive, preview: ArchivePreview, duplicates: ArchiveDuplicatePolicy, control: ArchiveControl): Promise<ArchiveImportReport> {
  return importArchive(
    archive,
    { preview, duplicates, timeZone: deviceTimeZone() },
    {
      ...control,
      db: db(),
      env: environment,
      writeTrack: async (recordingId, track) => {
        await writeTrack(recordingId, track.bytes);
      },
    },
  );
}

/** Kept without its refused files, which the undo does not need; `null` when the import wrote nothing. */
export async function saveLastArchiveImport(report: ArchiveImportReport): Promise<LastArchiveImport | null> {
  if (report.batches.length === 0) return null;
  const last: LastArchiveImport = { importedAt: environment.now(), report: { ...report, refused: [] } };
  await writeLocalState(lastImportFile, JSON.stringify(last));
  return last;
}

/** `null` once nothing is left to undo: no import yet, or one undone or reverted since. */
export async function lastArchiveImport(): Promise<LastArchiveImport | null> {
  const text = await readLocalState(lastImportFile);
  if (text === null) return null;
  let last: LastArchiveImport;
  try {
    last = lastImportSchema.parse(JSON.parse(text));
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof ZodError)) throw error;
    deleteLocalState(lastImportFile);
    return null;
  }
  if (archiveImportApplied(db(), last.report)) return last;
  deleteLocalState(lastImportFile);
  return null;
}

/** *Annuler l'import* (`IO-025`): every batch reverted at once, then the tracks the import wrote deleted. */
export async function undoArchive(report: ArchiveImportReport): Promise<void> {
  const summary = archiveImportSummary(report.format);
  const files = undoArchiveImport(db(), environment, report, {
    actor: userActor,
    summary: `Annulation : ${summary}`,
    restoredVersionSummary: (restoredNumber) => `Retour à la v${restoredNumber}`,
  });
  deleteLocalState(lastImportFile);
  for (const file of files) await deleteTrack(file);
}
