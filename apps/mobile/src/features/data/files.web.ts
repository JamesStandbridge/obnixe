import { getDocumentAsync } from "expo-document-picker";
import { backupFileExtension } from "@obnixe/core";
import type { ArchiveSource, ScratchFile, ScratchSpace } from "@obnixe/core";

export interface PickedFile {
  readonly name: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

export interface PickedArchive {
  readonly name: string;
  readonly source: ArchiveSource;
  release(): void;
}

const activityFileTypes = [".gpx", ".tcx", ".fit", ".gz", ".zip"];

export interface SharedFile {
  readonly name: string;
  readonly bytes: Uint8Array | string;
  readonly mimeType: string;
}

async function directory(path: readonly string[]): Promise<FileSystemDirectoryHandle> {
  let current = await navigator.storage.getDirectory();
  for (const part of path) current = await current.getDirectoryHandle(part, { create: true });
  return current;
}

function split(file: string): { readonly folders: readonly string[]; readonly name: string } {
  const parts = file.split("/").filter((part) => part.length > 0);
  const name = parts.pop() ?? file;
  return { folders: parts, name };
}

async function readEntry(path: readonly string[], name: string): Promise<Uint8Array | null> {
  const folder = await directory(path);
  try {
    const handle = await folder.getFileHandle(name);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

async function writeEntry(path: readonly string[], name: string, bytes: Uint8Array): Promise<void> {
  const folder = await directory(path);
  const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
  await writable.write(new Uint8Array(bytes));
  await writable.close();
}

async function deleteEntry(path: readonly string[], name: string): Promise<void> {
  const folder = await directory(path);
  try {
    await folder.removeEntry(name);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw error;
  }
}

export async function pickBackupFile(): Promise<PickedFile | null> {
  const result = await getDocumentAsync({ type: `.${backupFileExtension}`, multiple: false, base64: false });
  if (result.canceled) return null;
  const [asset] = result.assets;
  const file = asset?.file;
  if (asset === undefined || file === undefined) return null;
  return { name: asset.name, size: file.size, bytes: new Uint8Array(await file.arrayBuffer()) };
}

export async function pickActivityFile(): Promise<PickedFile | null> {
  const result = await getDocumentAsync({ type: activityFileTypes, multiple: false, base64: false });
  if (result.canceled) return null;
  const [asset] = result.assets;
  const file = asset?.file;
  if (asset === undefined || file === undefined) return null;
  return { name: asset.name, size: file.size, bytes: new Uint8Array(await file.arrayBuffer()) };
}

function blobSource(blob: Blob): ArchiveSource {
  return { size: blob.size, read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()) };
}

export async function pickArchiveFile(): Promise<PickedArchive | null> {
  const result = await getDocumentAsync({ type: [".zip"], multiple: false, base64: false });
  if (result.canceled) return null;
  const [asset] = result.assets;
  const file = asset?.file;
  if (asset === undefined || file === undefined) return null;
  return { name: asset.name, source: blobSource(file), release: () => undefined };
}

/** Browsers may keep large `Blob` parts on disk, out of the JavaScript heap. */
async function scratchFile(): Promise<ScratchFile> {
  let parts: Blob[] = [];
  return {
    append: async (bytes) => void parts.push(new Blob([new Uint8Array(bytes)])),
    finish: async () => blobSource(new Blob(parts)),
    discard: async () => void (parts = []),
  };
}

export function archiveScratch(): ScratchSpace {
  return scratchFile;
}

export async function readOpenedFile(uri: string): Promise<PickedFile> {
  const response = await fetch(uri);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { name: new URL(uri).pathname.split("/").pop() ?? uri, size: bytes.length, bytes };
}

export function releaseOpenedFile(_uri: string): void {}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function shareFile(shared: SharedFile): Promise<void> {
  const part = typeof shared.bytes === "string" ? shared.bytes : new Uint8Array(shared.bytes);
  download(shared.name, new Blob([part], { type: shared.mimeType }));
}

export interface StreamedFile {
  write(chunks: readonly Uint8Array[]): Promise<void>;
  share(): Promise<void>;
  discard(): void;
}

/** The browser keeps the chunks in a `Blob`, which it may page to disk, until the download. */
export function createStreamedFile(name: string, mimeType: string): StreamedFile {
  let parts: Blob[] = [];
  return {
    write: async (chunks) => {
      parts.push(new Blob(chunks.map((chunk) => new Uint8Array(chunk))));
    },
    share: async () => {
      download(name, new Blob(parts, { type: mimeType }));
      parts = [];
    },
    discard: () => {
      parts = [];
    },
  };
}

export async function readPhoto(file: string): Promise<Uint8Array | null> {
  const { folders, name } = split(file);
  return readEntry(folders, name);
}

export async function writePhoto(file: string, bytes: Uint8Array): Promise<void> {
  const { folders, name } = split(file);
  await writeEntry(folders, name, bytes);
}

export function deletePhoto(file: string): void {
  const { folders, name } = split(file);
  void deleteEntry(folders, name);
}

export async function writeKept(name: string, bytes: Uint8Array): Promise<void> {
  await writeEntry(["replaced"], name, bytes);
}

export async function readKept(name: string): Promise<Uint8Array | null> {
  return readEntry(["replaced"], name);
}

export function deleteKept(name: string): void {
  void deleteEntry(["replaced"], name);
}

export async function storageBytes(): Promise<number> {
  const estimate = await navigator.storage.estimate();
  return estimate.usage ?? 0;
}
