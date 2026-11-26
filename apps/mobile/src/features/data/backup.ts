import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/expo-sqlite";
import { getRandomValues } from "expo-crypto";
import { openDatabaseSync } from "expo-sqlite";
import {
  backupFileExtension,
  buildSnapshot,
  expiredReplacedSnapshots,
  expiredSafetyCopies,
  localDataSummary,
  mergeSnapshot,
  openSnapshot,
  packSnapshot,
  purgeExpiredTrash,
  readBackupHeader,
  replaceWithSnapshot,
  restorableTracks,
  sealSnapshot,
  summarizeSnapshot,
  unpackSnapshot,
} from "@obnixe/core";
import type { BackupHeader, MergeCounts, PhotoFile, Snapshot, SnapshotUpgrader, TableRow, TrackFile } from "@obnixe/core";
import { backup, schema } from "@obnixe/schema";
import migrations from "@obnixe/schema/migrations";
import type { Backup, BackupKind, EpochMs, Id } from "@obnixe/schema";
import { db, deleteSafetyCopy, environment } from "@/data/database";
import { deleteKept, deletePhoto, readKept, readPhoto, shareFile, writeKept, writePhoto } from "@/features/data/files";
import type { PickedFile } from "@/features/data/files";
import { fileStamp } from "@/features/data/format";
import { deleteTrack, readTrack, writeRouteTrack, writeTrack } from "@/features/tracking/trackStore";

const fillRandom = (bytes: Uint8Array): void => {
  getRandomValues(bytes);
};

const upgrader: SnapshotUpgrader = {
  migrations,
  openScratch: () => {
    const sqlite = openDatabaseSync(":memory:");
    return { db: drizzle(sqlite, { schema }), close: () => sqlite.closeSync() };
  },
};

export interface ExportRequest {
  readonly passphrase: string;
  readonly includePhotos: boolean;
  readonly onProgress?: (progress: number) => void;
}

export interface ExportResult {
  readonly fileName: string;
}

async function readPhotos(rows: readonly TableRow<"photo">[]): Promise<PhotoFile[]> {
  const files: PhotoFile[] = [];
  for (const row of rows) {
    const bytes = await readPhoto(row.file);
    if (bytes !== null) files.push({ photoId: row.id, bytes });
  }
  return files;
}

async function readTracks(tables: Snapshot["tables"]): Promise<TrackFile[]> {
  const files: TrackFile[] = [];
  for (const row of tables.recording) {
    const bytes = row.trackFile === null ? null : await readTrack(row.trackFile);
    if (bytes !== null) files.push({ kind: "recording", rowId: row.id, bytes });
  }
  for (const row of tables.route) {
    const bytes = await readTrack(row.trackFile);
    if (bytes !== null) files.push({ kind: "route", rowId: row.id, bytes });
  }
  return files;
}

async function currentSnapshot(now: EpochMs, includePhotos: boolean): Promise<Snapshot> {
  const base = buildSnapshot(db(), now);
  return { ...base, photos: includePhotos ? await readPhotos(base.tables.photo) : [], tracks: await readTracks(base.tables) };
}

function record(kind: BackupKind, snapshot: Snapshot, includesPhotos: boolean, sizeBytes: number, snapshotFile: string | null, createdAt: EpochMs): void {
  const summary = summarizeSnapshot(snapshot);
  db()
    .insert(backup)
    .values({
      id: environment.newId(),
      kind,
      schemaVersion: snapshot.schemaVersion,
      catalogVersion: snapshot.catalogVersion,
      includesPhotos,
      sizeBytes,
      coveredFrom: summary.coveredFrom,
      coveredTo: summary.coveredTo,
      snapshotFile,
      createdAt,
    })
    .run();
}

export async function exportBackup(request: ExportRequest): Promise<ExportResult> {
  const now = environment.now();
  const snapshot = await currentSnapshot(now, request.includePhotos);
  const sealed = await sealSnapshot(snapshot, {
    passphrase: request.passphrase,
    fillRandom,
    ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
  });
  const fileName = `obnixe-${fileStamp(now)}.${backupFileExtension}`;
  await shareFile({ name: fileName, bytes: sealed.bytes, mimeType: "application/octet-stream" });
  record("export", snapshot, request.includePhotos, sealed.bytes.length, null, now);
  return { fileName };
}

export interface ChosenBackup {
  readonly name: string;
  readonly size: number;
  readonly bytes: Uint8Array;
  readonly header: BackupHeader;
}

export function inspectBackup(file: PickedFile): ChosenBackup {
  return { name: file.name, size: file.size, bytes: file.bytes, header: readBackupHeader(file.bytes) };
}

export function unlockBackup(chosen: ChosenBackup, passphrase: string, onProgress: (progress: number) => void): Promise<Snapshot> {
  return openSnapshot(chosen.bytes, { passphrase, onProgress, upgrader });
}

export type ImportMode = "merge" | "replace";

export type ImportOutcome =
  | { readonly mode: "merge"; readonly changesetId: Id | null; readonly counts: MergeCounts }
  | { readonly mode: "replace"; readonly changesetId: Id };

async function writePhotos(snapshot: Snapshot, photoIds: ReadonlySet<Id> | null): Promise<void> {
  const files = new Map(snapshot.tables.photo.map((row) => [row.id, row.file]));
  for (const photo of snapshot.photos) {
    const file = files.get(photo.photoId);
    if (file === undefined || (photoIds !== null && !photoIds.has(photo.photoId))) continue;
    await writePhoto(file, photo.bytes);
  }
}

/** Track files are written after the commit; a track whose write fails is rebuilt or reported « Trace indisponible » at the next launch. */
async function writeTracks(snapshot: Snapshot, rowIds: ReadonlySet<Id> | null): Promise<void> {
  for (const track of restorableTracks(snapshot, rowIds)) {
    switch (track.kind) {
      case "recording":
        await writeTrack(track.rowId, track.bytes);
        break;
      case "route":
        await writeRouteTrack(track.rowId, track.bytes);
        break;
      default: {
        const unreachable: never = track.kind;
        throw new Error(`Unhandled track file kind ${String(unreachable)}`);
      }
    }
  }
}

async function keepCurrent(now: EpochMs): Promise<{ readonly snapshot: Snapshot; readonly name: string; readonly size: number }> {
  const snapshot = await currentSnapshot(now, true);
  const packed = packSnapshot(snapshot);
  const name = `replaced-${environment.newId()}.bin`;
  await writeKept(name, packed);
  return { snapshot, name, size: packed.length };
}

export async function importBackup(snapshot: Snapshot, mode: ImportMode): Promise<ImportOutcome> {
  const now = environment.now();
  switch (mode) {
    case "merge": {
      const result = mergeSnapshot(db(), environment, snapshot);
      await writePhotos(snapshot, new Set(result.photoIds));
      await writeTracks(snapshot, new Set(result.trackRowIds));
      record("import_merge", snapshot, snapshot.photos.length > 0, 0, null, now);
      return { mode, changesetId: result.changesetId, counts: result.counts };
    }
    case "replace": {
      const kept = localDataSummary(db()).hasData ? await keepCurrent(now) : null;
      const changesetId = replaceWithSnapshot(db(), environment, snapshot);
      await writePhotos(snapshot, null);
      await writeTracks(snapshot, null);
      if (kept !== null) {
        const remaining = new Set(snapshot.tables.photo.map((row) => row.file));
        for (const row of kept.snapshot.tables.photo) if (!remaining.has(row.file)) deletePhoto(row.file);
        const remainingTracks = new Set([...snapshot.tables.recording.map((row) => row.trackFile), ...snapshot.tables.route.map((row) => row.trackFile)]);
        const keptTracks = [...kept.snapshot.tables.recording.map((row) => row.trackFile), ...kept.snapshot.tables.route.map((row) => row.trackFile)];
        for (const file of keptTracks) if (file !== null && !remainingTracks.has(file)) await deleteTrack(file);
      }
      record("import_replace", kept?.snapshot ?? snapshot, snapshot.photos.length > 0, kept?.size ?? 0, kept?.name ?? null, now);
      return { mode, changesetId };
    }
    default: {
      const unreachable: never = mode;
      throw new Error(`Unhandled import mode ${String(unreachable)}`);
    }
  }
}

export class KeptSnapshotMissingError extends Error {
  constructor(readonly file: string) {
    super(`Kept snapshot ${file} is missing`);
  }
}

export async function restoreReplaced(row: Backup): Promise<void> {
  const file = row.snapshotFile;
  if (file === null) throw new KeptSnapshotMissingError(String(row.id));
  const bytes = await readKept(file);
  if (bytes === null) throw new KeptSnapshotMissingError(file);
  await importBackup(unpackSnapshot(bytes, upgrader), "replace");
  deleteKept(file);
  db().update(backup).set({ snapshotFile: null }).where(eq(backup.id, row.id)).run();
}

/** `INT-031`: files of purged rows go after the rows; one left behind by a crash is swept by the launch reconciliation. */
export async function runHousekeeping(): Promise<void> {
  const purged = purgeExpiredTrash(db(), environment);
  for (const file of purged.photoFiles) deletePhoto(file);
  for (const file of purged.trackFiles) await deleteTrack(file);
  for (const row of expiredReplacedSnapshots(db(), environment.now())) {
    if (row.snapshotFile !== null) deleteKept(row.snapshotFile);
    db().update(backup).set({ snapshotFile: null }).where(eq(backup.id, row.id)).run();
  }
  for (const row of expiredSafetyCopies(db(), environment.now())) {
    if (row.snapshotFile !== null) deleteSafetyCopy(row.snapshotFile);
    db().update(backup).set({ snapshotFile: null }).where(eq(backup.id, row.id)).run();
  }
}