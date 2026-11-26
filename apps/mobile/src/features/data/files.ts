import { getDocumentAsync } from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import { shareAsync } from "expo-sharing";

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

const keptDirectory = (): Directory => new Directory(Paths.document, "replaced");
const exportDirectory = (): Directory => new Directory(Paths.cache, "exports");

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
