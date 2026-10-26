import { z } from "zod";
import type { EpochMs, Id } from "@obnixe/schema";
import { decodeUtf8, encodeUtf8, InvalidUtf8Error } from "../utf8.ts";
import { CorruptedBackupError, parseSnapshotSettings, parseSnapshotTables } from "./snapshot.ts";
import type { PhotoFile, Snapshot } from "./snapshot.ts";

const lengthBytes = 4;

const documentSchema = z.object({
  format: z.literal("obnixe-snapshot"),
  schemaVersion: z.int().positive(),
  catalogVersion: z.int().positive(),
  createdAt: z.int(),
  settings: z.unknown(),
  tables: z.unknown(),
  photos: z.array(z.object({ photoId: z.string(), offset: z.int().nonnegative(), length: z.int().nonnegative() })),
});

export function packSnapshot(snapshot: Snapshot): Uint8Array {
  let offset = 0;
  const photos = snapshot.photos.map((file) => {
    const entry = { photoId: file.photoId, offset, length: file.bytes.length };
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
    }),
  );
  const packed = new Uint8Array(lengthBytes + document.length + offset);
  new DataView(packed.buffer).setUint32(0, document.length);
  packed.set(document, lengthBytes);
  let cursor = lengthBytes + document.length;
  for (const file of snapshot.photos) {
    packed.set(file.bytes, cursor);
    cursor += file.bytes.length;
  }
  return packed;
}

export function unpackSnapshot(packed: Uint8Array): Snapshot {
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
  return {
    schemaVersion: document.schemaVersion,
    catalogVersion: document.catalogVersion,
    createdAt: document.createdAt as EpochMs,
    settings: parseSnapshotSettings(document.settings),
    tables: parseSnapshotTables(document.tables),
    photos,
  };
}

function parseDocument(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch (error) {
    if (error instanceof InvalidUtf8Error || error instanceof SyntaxError) throw new CorruptedBackupError(error.message);
    throw error;
  }
}
