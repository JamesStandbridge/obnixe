import { z } from "zod";
import type { EpochMs, Id } from "@obnixe/schema";
import { decodeUtf8, encodeUtf8, InvalidUtf8Error } from "../utf8.ts";
import { backupSchemaVersion, CorruptedBackupError, parseSnapshotSettings, parseSnapshotTables, trackFileKinds } from "./snapshot.ts";
import type { PhotoFile, Snapshot, TrackFile } from "./snapshot.ts";
import { upgradeSnapshot } from "./upgrade.ts";
import type { SnapshotUpgrader } from "./upgrade.ts";

const lengthBytes = 4;

const documentSchema = z.object({
  format: z.literal("obnixe-snapshot"),
  schemaVersion: z.int().positive(),
  catalogVersion: z.int().positive(),
  createdAt: z.int(),
  settings: z.unknown(),
  tables: z.unknown(),
  photos: z.array(z.object({ photoId: z.string(), offset: z.int().nonnegative(), length: z.int().nonnegative() })),
  tracks: z.array(z.object({ kind: z.enum(trackFileKinds), rowId: z.string(), offset: z.int().nonnegative(), length: z.int().nonnegative() })).default([]),
});

export function packSnapshot(snapshot: Snapshot): Uint8Array {
  let offset = 0;
  const photos = snapshot.photos.map((file) => {
    const entry = { photoId: file.photoId, offset, length: file.bytes.length };
    offset += file.bytes.length;
    return entry;
  });
  const tracks = snapshot.tracks.map((file) => {
    const entry = { kind: file.kind, rowId: file.rowId, offset, length: file.bytes.length };
    offset += file.bytes.length;
    return entry;
  });
  const document = encodeUtf8(
    JSON.stringify({
      format: "obnixe-snapshot",
      schemaVersion: snapshot.schemaVersion,
      catalogVersion: snapshot.catalogVersion,
      createdAt: snapshot.createdAt,
      settings: snapshot.settings,
      tables: snapshot.tables,
      photos,
      tracks,
    }),
  );
  const packed = new Uint8Array(lengthBytes + document.length + offset);
  new DataView(packed.buffer).setUint32(0, document.length);
  packed.set(document, lengthBytes);
  let cursor = lengthBytes + document.length;
  for (const file of [...snapshot.photos, ...snapshot.tracks]) {
    packed.set(file.bytes, cursor);
    cursor += file.bytes.length;
  }
  return packed;
}

/** A snapshot document whose settings and tables are still in the shape of its own schema version. */
export interface PackedSnapshot {
  readonly schemaVersion: number;
  readonly catalogVersion: number;
  readonly createdAt: EpochMs;
  readonly settings: unknown;
  readonly tables: unknown;
  readonly photos: readonly PhotoFile[];
  readonly tracks: readonly TrackFile[];
}

/** Snapshots of an older schema version are first carried through the database migrations, so their rows are validated against the current catalog only once converted. */
export function unpackSnapshot(packed: Uint8Array, upgrader: SnapshotUpgrader): Snapshot {
  return parsePackedSnapshot(readPackedSnapshot(packed), upgrader);
}

export function parsePackedSnapshot(document: PackedSnapshot, upgrader: SnapshotUpgrader): Snapshot {
  if (document.schemaVersion < backupSchemaVersion) return upgradeSnapshot(document, upgrader);
  return { ...document, settings: parseSnapshotSettings(document.settings), tables: parseSnapshotTables(document.tables) };
}

export function readPackedSnapshot(packed: Uint8Array): PackedSnapshot {
  if (packed.length < lengthBytes) throw new CorruptedBackupError("snapshot too short");
  const documentLength = new DataView(packed.buffer, packed.byteOffset, packed.byteLength).getUint32(0);
  const blobsStart = lengthBytes + documentLength;
  if (blobsStart > packed.length) throw new CorruptedBackupError("snapshot document truncated");
  const raw = parseDocument(packed.subarray(lengthBytes, blobsStart));
  const parsed = documentSchema.safeParse(raw);
  if (!parsed.success) throw new CorruptedBackupError(parsed.error.message);
  const document = parsed.data;
  const blobs = packed.subarray(blobsStart);
  const photos: PhotoFile[] = document.photos.map((entry) => {
    if (entry.offset + entry.length > blobs.length) throw new CorruptedBackupError(`photo ${entry.photoId} truncated`);
    return { photoId: entry.photoId as Id, bytes: blobs.slice(entry.offset, entry.offset + entry.length) };
  });
  const tracks: TrackFile[] = document.tracks.map((entry) => {
    if (entry.offset + entry.length > blobs.length) throw new CorruptedBackupError(`track ${entry.rowId} truncated`);
    return { kind: entry.kind, rowId: entry.rowId as Id, bytes: blobs.slice(entry.offset, entry.offset + entry.length) };
  });
  return { schemaVersion: document.schemaVersion, catalogVersion: document.catalogVersion, createdAt: document.createdAt as EpochMs, settings: document.settings, tables: document.tables, photos, tracks };
}

function parseDocument(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch (error) {
    if (error instanceof InvalidUtf8Error || error instanceof SyntaxError) throw new CorruptedBackupError(error.message);
    throw error;
  }
}
