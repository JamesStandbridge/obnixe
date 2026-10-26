import { eq } from "drizzle-orm";
import { getRandomValues } from "expo-crypto";
import {
  backupFileExtension,
  buildSnapshot,
  expiredReplacedSnapshots,
  localDataSummary,
  mergeSnapshot,
  openSnapshot,
  packSnapshot,
  purgeExpiredTrash,
  readBackupHeader,
  replaceWithSnapshot,
  sealSnapshot,
  summarizeSnapshot,
  unpackSnapshot,
} from "@obnixe/core";
import type { BackupHeader, MergeCounts, PhotoFile, Snapshot, TableRow } from "@obnixe/core";
import { backup } from "@obnixe/schema";
import type { Backup, BackupKind, EpochMs, Id } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { deleteKept, deletePhoto, readKept, readPhoto, shareFile, writeKept, writePhoto } from "@/features/data/files";
import type { PickedFile } from "@/features/data/files";
import { fileStamp } from "@/features/data/format";

const fillRandom = (bytes: Uint8Array): void => {
  getRandomValues(bytes);
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
  const base = buildSnapshot(db(), now);
  const snapshot: Snapshot = { ...base, photos: request.includePhotos ? await readPhotos(base.tables.photo) : [] };
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
  return openSnapshot(chosen.bytes, { passphrase, onProgress });
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

async function keepCurrent(now: EpochMs): Promise<{ readonly snapshot: Snapshot; readonly name: string; readonly size: number }> {
  const base = buildSnapshot(db(), now);
  const snapshot: Snapshot = { ...base, photos: await readPhotos(base.tables.photo) };
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
      record("import_merge", snapshot, snapshot.photos.length > 0, 0, null, now);
      return { mode, changesetId: result.changesetId, counts: result.counts };
    }
    case "replace": {
      const kept = localDataSummary(db()).hasData ? await keepCurrent(now) : null;
      const changesetId = replaceWithSnapshot(db(), environment, snapshot);
      await writePhotos(snapshot, null);
      if (kept !== null) {
        const remaining = new Set(snapshot.tables.photo.map((row) => row.file));
        for (const row of kept.snapshot.tables.photo) if (!remaining.has(row.file)) deletePhoto(row.file);
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
  await importBackup(unpackSnapshot(bytes), "replace");
  deleteKept(file);
  db().update(backup).set({ snapshotFile: null }).where(eq(backup.id, row.id)).run();
}

export function runHousekeeping(): void {
  const purged = purgeExpiredTrash(db(), environment);
  for (const file of purged.photoFiles) deletePhoto(file);
  for (const row of expiredReplacedSnapshots(db(), environment.now())) {
    if (row.snapshotFile !== null) deleteKept(row.snapshotFile);
    db().update(backup).set({ snapshotFile: null }).where(eq(backup.id, row.id)).run();
  }
}