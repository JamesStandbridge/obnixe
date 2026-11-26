import { Directory, File, Paths } from "expo-file-system";
import { routeDirectory, routeFilePath, trackDigest, trackDirectory, trackFileExtension, trackFilePath } from "@obnixe/core";
import type { StoredTrack } from "@obnixe/core";
import type { Id } from "@obnixe/schema";

/*
 * Raw journals live in `recordings/<sessionId>.ojr` under the document directory, track files at `trackFilePath`,
 * the relative path `recording.track_file` holds (annex C), route files at `routeFilePath` (`DEC-11`).
 */

const journalExtension = ".ojr";
const temporaryExtension = ".tmp";

export class TrackWriteError extends Error {
  constructor(readonly file: string) {
    super(`Track ${file} did not read back identical`);
  }
}

const journals = (): Directory => new Directory(Paths.document, "recordings");
const tracks = (): Directory => new Directory(Paths.document, trackDirectory);
const routes = (): Directory => new Directory(Paths.document, routeDirectory);

function ensure(directory: Directory): Directory {
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function names(directory: Directory, extension: string): readonly string[] {
  if (!directory.exists) return [];
  return directory.list().flatMap((entry) => (entry instanceof File && entry.name.endsWith(extension) ? [entry.name] : []));
}

/** The URI handed to the native tracker, which creates or continues the journal there. */
export function journalUri(sessionId: Id): string {
  return new File(ensure(journals()), `${sessionId}${journalExtension}`).uri;
}

export async function readJournalFile(sessionId: Id): Promise<Uint8Array | null> {
  const file = new File(journals(), `${sessionId}${journalExtension}`);
  return file.exists ? file.bytes() : null;
}

export async function journalSessionIds(): Promise<readonly Id[]> {
  return names(journals(), journalExtension).map((name) => name.slice(0, -journalExtension.length) as Id);
}

export async function deleteJournal(sessionId: Id): Promise<void> {
  const file = new File(journals(), `${sessionId}${journalExtension}`);
  if (file.exists) file.delete();
}

/**
 * `DAT-020`: written to a temporary file, read back and hashed, then renamed over the final name. expo-file-system
 * exposes no fsync; the read back is the durability check available to JavaScript.
 */
async function writeVerified(directory: Directory, file: string, bytes: Uint8Array): Promise<StoredTrack> {
  ensure(directory);
  const temporary = new File(Paths.document, `${file}${temporaryExtension}`);
  if (temporary.exists) temporary.delete();
  temporary.create();
  await temporary.write(bytes);
  const sha256 = trackDigest(bytes);
  if (trackDigest(await temporary.bytes()) !== sha256) {
    temporary.delete();
    throw new TrackWriteError(file);
  }
  await temporary.move(new File(Paths.document, file), { overwrite: true });
  return { file, sha256, bytes: bytes.length };
}

export function writeTrack(recordingId: Id, bytes: Uint8Array): Promise<StoredTrack> {
  return writeVerified(tracks(), trackFilePath(recordingId), bytes);
}

export function writeRouteTrack(routeId: Id, bytes: Uint8Array): Promise<StoredTrack> {
  return writeVerified(routes(), routeFilePath(routeId), bytes);
}

/** Synchronous read for the agent tools, which answer within one call (`readTrack` of the agent environment). */
export function readTrackFile(file: string): Uint8Array | null {
  const target = new File(Paths.document, file);
  return target.exists ? target.bytesSync() : null;
}

export async function readTrack(file: string): Promise<Uint8Array | null> {
  return readTrackFile(file);
}

export async function deleteTrack(file: string): Promise<void> {
  const target = new File(Paths.document, file);
  if (target.exists) target.delete();
}

/** Track and route files on disk: one no row references is an orphan of the launch reconciliation. */
export async function storedTrackFiles(): Promise<readonly string[]> {
  const idOf = (name: string): Id => name.slice(0, -trackFileExtension.length) as Id;
  return [...names(tracks(), trackFileExtension).map((name) => trackFilePath(idOf(name))), ...names(routes(), trackFileExtension).map((name) => routeFilePath(idOf(name)))];
}

export async function sweepTemporaryTracks(): Promise<void> {
  for (const directory of [tracks(), routes()]) for (const name of names(directory, temporaryExtension)) new File(directory, name).delete();
}

export async function availableBytes(): Promise<number> {
  return Paths.availableDiskSpace;
}
