import { getDocumentAsync } from "expo-document-picker";
import { backupFileExtension } from "@obnixe/core";

export interface PickedFile {
  readonly name: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

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

export async function shareFile(shared: SharedFile): Promise<void> {
  const part = typeof shared.bytes === "string" ? shared.bytes : new Uint8Array(shared.bytes);
  const url = URL.createObjectURL(new Blob([part], { type: shared.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = shared.name;
  anchor.click();
  URL.revokeObjectURL(url);
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
