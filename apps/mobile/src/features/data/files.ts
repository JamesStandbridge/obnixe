import { getDocumentAsync } from "expo-document-picker";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import type { FileHandle } from "expo-file-system";
import { shareAsync } from "expo-sharing";
import type { ArchiveSource, ScratchFile, ScratchSpace } from "@obnixe/core";

export interface PickedFile {
  readonly name: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

/** An archive read by ranges, never whole (`IO-021`); `release` closes it and removes the picker's copy. */
export interface PickedArchive {
  readonly name: string;
  readonly source: ArchiveSource;
  release(): void;
}

export interface SharedFile {
  readonly name: string;
  readonly bytes: Uint8Array | string;
  readonly mimeType: string;
}

const keptDirectory = (): Directory => new Directory(Paths.document, "replaced");
const exportDirectory = (): Directory => new Directory(Paths.cache, "exports");
const scratchDirectory = (): Directory => new Directory(Paths.cache, "archive-scratch");

function ensure(directory: Directory): Directory {
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

/** `photo.file` is either an absolute file URI or a path relative to the document directory. */
function photoFile(file: string): File {
  return file.startsWith("file:") ? new File(file) : new File(Paths.document, file);
}

/** Any type: phones label `.obnixe`, `.fit` and `.tcx` files inconsistently, so the content decides. */
async function pickFile(): Promise<PickedFile | null> {
  const result = await getDocumentAsync({ type: "*/*", copyToCacheDirectory: true, multiple: false });
  if (result.canceled) return null;
  const [asset] = result.assets;
  if (asset === undefined) return null;
  const file = new File(asset.uri);
  const bytes = await file.bytes();
  return { name: asset.name, size: asset.size ?? bytes.length, bytes };
}

export async function pickBackupFile(): Promise<PickedFile | null> {
  return pickFile();
}

export async function pickActivityFile(): Promise<PickedFile | null> {
  return pickFile();
}

/** A handle moves one offset for every call: reads are chained so that each one seeks then reads alone. */
function handleSource(handle: FileHandle, size: number): ArchiveSource {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    const bytes = new Uint8Array(length);
    let filled = 0;
    handle.offset = offset;
    while (filled < length) {
      const chunk = await handle.readBytes(length - filled);
      if (chunk.length === 0) break;
      bytes.set(chunk, filled);
      filled += chunk.length;
    }
    return filled === length ? bytes : bytes.subarray(0, filled);
  };
  return {
    size,
    read: (offset, length) => {
      const next = queue.then(() => read(offset, length));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/**
 * Read where the picker leaves it, so that an archive of several gigabytes is not copied once more: an Android `content://`
 * grant, which stays the user's file, or the copy iOS makes in the app's temporary directory, removed after the import.
 */
export async function pickArchiveFile(): Promise<PickedArchive | null> {
  const result = await getDocumentAsync({ type: "*/*", copyToCacheDirectory: false, multiple: false });
  if (result.canceled) return null;
  const [asset] = result.assets;
  if (asset === undefined) return null;
  const file = new File(asset.uri);
  const handle = file.open(FileMode.ReadOnly);
  return {
    name: asset.name,
    source: handleSource(handle, handle.size ?? asset.size ?? file.size),
    release: () => {
      handle.close();
      if (asset.uri.startsWith("file:") && file.exists) file.delete();
    },
  };
}

async function scratchFile(directory: Directory): Promise<ScratchFile> {
  const file = new File(directory, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.zip`);
  file.create();
  let handle = file.open(FileMode.WriteOnly);
  return {
    append: (bytes) => handle.writeBytes(bytes),
    finish: async () => {
      handle.close();
      handle = file.open(FileMode.ReadOnly);
      return handleSource(handle, file.size);
    },
    discard: async () => {
      handle.close();
      if (file.exists) file.delete();
    },
  };
}

/** Temporary files for the nested archives of an account export; those an interrupted import left behind go first. */
export function archiveScratch(): ScratchSpace {
  const directory = scratchDirectory();
  if (directory.exists) directory.delete();
  ensure(directory);
  return () => scratchFile(directory);
}

/** A file shared to the app or opened with it (`IO-051`): an Android `content://` grant or an iOS `file://` inbox copy. */
export async function readOpenedFile(uri: string): Promise<PickedFile> {
  const file = new File(uri);
  const bytes = await file.bytes();
  return { name: file.name, size: bytes.length, bytes };
}

/** iOS copies every opened file into `Documents/Inbox`, where nothing else removes it. */
export function releaseOpenedFile(uri: string): void {
  if (!uri.startsWith(`${new Directory(Paths.document, "Inbox").uri}/`)) return;
  const file = new File(uri);
  if (file.exists) file.delete();
}

export async function shareFile(shared: SharedFile): Promise<void> {
  const file = new File(ensure(exportDirectory()), shared.name);
  if (file.exists) file.delete();
  file.create();
  await file.write(shared.bytes);
  await shareAsync(file.uri, { mimeType: shared.mimeType, dialogTitle: shared.name });
}

export async function readPhoto(file: string): Promise<Uint8Array | null> {
  const target = photoFile(file);
  return target.exists ? target.bytes() : null;
}

export async function writePhoto(file: string, bytes: Uint8Array): Promise<void> {
  const target = photoFile(file);
  ensure(target.parentDirectory);
  if (target.exists) target.delete();
  target.create();
  await target.write(bytes);
}

export function deletePhoto(file: string): void {
  const target = photoFile(file);
  if (target.exists) target.delete();
}

export async function writeKept(name: string, bytes: Uint8Array): Promise<void> {
  const file = new File(ensure(keptDirectory()), name);
  if (file.exists) file.delete();
  file.create();
  await file.write(bytes);
}

export async function readKept(name: string): Promise<Uint8Array | null> {
  const file = new File(keptDirectory(), name);
  return file.exists ? file.bytes() : null;
}

export function deleteKept(name: string): void {
  const file = new File(keptDirectory(), name);
  if (file.exists) file.delete();
}

/** The SQLite database, photos and kept snapshots all live under the document directory. */
export async function storageBytes(): Promise<number> {
  const directory = new Directory(Paths.document);
  return directory.exists ? (directory.size ?? 0) : 0;
}
