import { routeDirectory, routeFilePath, trackDigest, trackDirectory, trackFileExtension, trackFilePath } from "@obnixe/core";
import type { StoredTrack } from "@obnixe/core";
import type { Id } from "@obnixe/schema";

/*
 * `PLT-021`: the web build shows, imports and exports activities but never records, so it has no raw journal; track
 * and route files live in the origin private file system under the same `trackFilePath` and `routeFilePath` paths as on the phone.
 */

const temporaryExtension = ".tmp";

export class TrackWriteError extends Error {
  constructor(readonly file: string) {
    super(`Track ${file} did not read back identical`);
  }
}

const directories = [trackDirectory, routeDirectory] as const;
type TrackDirectory = (typeof directories)[number];

interface StoredName {
  readonly directory: TrackDirectory;
  readonly name: string;
}

async function folderOf(directory: TrackDirectory): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(directory, { create: true });
}

function nameOf(file: string): StoredName | null {
  for (const directory of directories) {
    const prefix = `${directory}/`;
    if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) return { directory, name: file.slice(prefix.length) };
  }
  return null;
}

function isMissing(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotFoundError" || error.name === "TypeMismatchError");
}

async function readEntry(folder: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | null> {
  try {
    const handle = await folder.getFileHandle(name);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function writeEntry(folder: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  const handle = await folder.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  await stream.write(new Uint8Array(bytes));
  await stream.close();
}

async function removeEntry(folder: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await folder.removeEntry(name);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function entryNames(folder: FileSystemDirectoryHandle, extension: string): Promise<readonly string[]> {
  const found: string[] = [];
  for await (const [name, handle] of folder.entries()) if (handle.kind === "file" && name.endsWith(extension)) found.push(name);
  return found;
}

export function journalUri(_sessionId: Id): string {
  throw new Error("The web build does not record");
}

export async function readJournalFile(_sessionId: Id): Promise<Uint8Array | null> {
  return null;
}

export async function journalSessionIds(): Promise<readonly Id[]> {
  return [];
}

export async function deleteJournal(_sessionId: Id): Promise<void> {}

/** OPFS has no rename for a file handle in every browser: the verified temporary copy is rewritten under the final name. */
async function writeVerified(directory: TrackDirectory, file: string, bytes: Uint8Array): Promise<StoredTrack> {
  const folder = await folderOf(directory);
  const name = file.slice(directory.length + 1);
  const temporary = `${name}${temporaryExtension}`;
  const sha256 = trackDigest(bytes);
  await writeEntry(folder, temporary, bytes);
  const written = await readEntry(folder, temporary);
  if (written === null || trackDigest(written) !== sha256) {
    await removeEntry(folder, temporary);
    throw new TrackWriteError(file);
  }
  await writeEntry(folder, name, bytes);
  await removeEntry(folder, temporary);
  return { file, sha256, bytes: bytes.length };
}

export function writeTrack(recordingId: Id, bytes: Uint8Array): Promise<StoredTrack> {
  return writeVerified(trackDirectory, trackFilePath(recordingId), bytes);
}

export function writeRouteTrack(routeId: Id, bytes: Uint8Array): Promise<StoredTrack> {
  return writeVerified(routeDirectory, routeFilePath(routeId), bytes);
}

/** OPFS has no synchronous read outside workers, so agent tool calls cannot open tracks on the web. */
export function readTrackFile(_file: string): Uint8Array | null {
  return null;
}

export async function readTrack(file: string): Promise<Uint8Array | null> {
  const stored = nameOf(file);
  return stored === null ? null : readEntry(await folderOf(stored.directory), stored.name);
}

export async function deleteTrack(file: string): Promise<void> {
  const stored = nameOf(file);
  if (stored !== null) await removeEntry(await folderOf(stored.directory), stored.name);
}

export async function storedTrackFiles(): Promise<readonly string[]> {
  const files: string[] = [];
  for (const directory of directories) {
    for (const name of await entryNames(await folderOf(directory), trackFileExtension)) files.push(`${directory}/${name}`);
  }
  return files;
}

export async function sweepTemporaryTracks(): Promise<void> {
  for (const directory of directories) {
    const folder = await folderOf(directory);
    for (const name of await entryNames(folder, temporaryExtension)) await removeEntry(folder, name);
  }
}

export async function availableBytes(): Promise<number> {
  const estimate = await navigator.storage.estimate();
  return Math.max(0, (estimate.quota ?? 0) - (estimate.usage ?? 0));
}
