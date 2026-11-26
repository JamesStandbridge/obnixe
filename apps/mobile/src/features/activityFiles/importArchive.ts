import { archiveImportSummary, archiveSliceMs, importArchive, previewArchive, slicedPace, undoArchiveImport } from "@obnixe/core";
import type { Actor, ArchiveControl, ArchiveDuplicatePolicy, ArchiveErrorReason, ArchiveImportReport, ArchivePreview, ArchiveProgress, ArchiveRefusalReason, OpenedArchive } from "@obnixe/core";
import { db, environment } from "@/data/database";
import { importErrorMessage } from "@/features/activityFiles/importActivity";
import { deleteTrack, writeTrack } from "@/features/tracking/trackStore";
import { deviceTimeZone } from "@/format/dates";

const userActor: Actor = { author: "user", connectionId: null };

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

/** *Annuler l'import* (`IO-025`): every batch reverted at once, then the tracks the import wrote deleted. */
export async function undoArchive(report: ArchiveImportReport): Promise<void> {
  const summary = archiveImportSummary(report.format);
  const files = undoArchiveImport(db(), environment, report, {
    actor: userActor,
    summary: `Annulation : ${summary}`,
    restoredVersionSummary: (restoredNumber) => `Retour à la v${restoredNumber}`,
  });
  for (const file of files) await deleteTrack(file);
}
