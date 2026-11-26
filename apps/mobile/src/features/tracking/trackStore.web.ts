import { trackDigest, trackDirectory, trackFileExtension, trackFilePath } from "@obnixe/core";
import type { StoredTrack } from "@obnixe/core";
import type { Id } from "@obnixe/schema";

/*
 * `PLT-021`: the web build shows, imports and exports activities but never records, so it has no raw journal; track
 * files live in the origin private file system under the same `trackFilePath` paths as on the phone.
 */

const temporaryExtension = ".tmp";

export class TrackWriteError extends Error {
  constructor(readonly file: string) {
    super(`Track ${file} did not read back identical`);
  }
}

async function tracks(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(trackDirectory, { create: true });
}

function nameOf(file: string): string | null {
  const prefix = `${trackDirectory}/`;
  return file.startsWith(prefix) && !file.slice(prefix.length).includes("/") ? file.slice(prefix.length) : null;
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

async function entryNames(extension: string): Promise<readonly string[]> {
  const folder = await tracks();
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
export async function writeTrack(recordingId: Id, bytes: Uint8Array): Promise<StoredTrack> {
  const file = trackFilePath(recordingId);
  const folder = await tracks();
  const name = `${recordingId}${trackFileExtension}`;
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

/** OPFS has no synchronous read outside workers, so agent tool calls cannot open tracks on the web. */
export function readTrackFile(_file: string): Uint8Array | null {
  return null;
}

export async function readTrack(file: string): Promise<Uint8Array | null> {
  const name = nameOf(file);
  return name === null ? null : readEntry(await tracks(), name);
}

export async function deleteTrack(file: string): Promise<void> {
  const name = nameOf(file);
  if (name !== null) await removeEntry(await tracks(), name);
}

export async function storedTrackFiles(): Promise<readonly string[]> {
  return (await entryNames(trackFileExtension)).map((name) => trackFilePath(name.slice(0, -trackFileExtension.length) as Id));
}

export async function sweepTemporaryTracks(): Promise<void> {
  const folder = await tracks();
  for (const name of await entryNames(temporaryExtension)) await removeEntry(folder, name);
}

export async function availableBytes(): Promise<number> {
  const estimate = await navigator.storage.estimate();
  return Math.max(0, (estimate.quota ?? 0) - (estimate.usage ?? 0));
}
