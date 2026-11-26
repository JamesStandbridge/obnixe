import { Directory, File, Paths } from "expo-file-system";
import { trackDigest } from "@obnixe/core";
import type { StoredTrack } from "@obnixe/core";
import type { Id } from "@obnixe/schema";

/*
 * Raw journals live in `recordings/<sessionId>.ojr`, track files in `tracks/<recordingId>.otrk` under the document
 * directory; `recording.track_file` holds that relative path (annex C).
 */

const journalExtension = ".ojr";
const trackExtension = ".otrk";
const temporaryExtension = ".tmp";

export class TrackWriteError extends Error {
  constructor(readonly file: string) {
    super(`Track ${file} did not read back identical`);
  }
}

const journals = (): Directory => new Directory(Paths.document, "recordings");
const tracks = (): Directory => new Directory(Paths.document, "tracks");

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

export async function readJournal(sessionId: Id): Promise<Uint8Array | null> {
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

export function trackFileOf(recordingId: Id): string {
  return `tracks/${recordingId}${trackExtension}`;
}

/**
 * `DAT-020`: written to a temporary file, read back and hashed, then renamed over the final name. expo-file-system
 * exposes no fsync; the read back is the durability check available to JavaScript.
 */
export async function writeTrack(recordingId: Id, bytes: Uint8Array): Promise<StoredTrack> {
  const file = trackFileOf(recordingId);
  const directory = ensure(tracks());
  const temporary = new File(directory, `${recordingId}${trackExtension}${temporaryExtension}`);
  if (temporary.exists) temporary.delete();
  temporary.create();
  await temporary.write(bytes);
  const sha256 = trackDigest(bytes);
  if (trackDigest(await temporary.bytes()) !== sha256) {
    temporary.delete();
    throw new TrackWriteError(file);
  }
  await temporary.move(new File(directory, `${recordingId}${trackExtension}`), { overwrite: true });
  return { file, sha256, bytes: bytes.length };
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

export async function storedTrackFiles(): Promise<readonly string[]> {
  return names(tracks(), trackExtension).map((name) => `tracks/${name}`);
}

export async function sweepTemporaryTracks(): Promise<void> {
  const directory = tracks();
  for (const name of names(directory, temporaryExtension)) new File(directory, name).delete();
}

export async function availableBytes(): Promise<number> {
  return Paths.availableDiskSpace;
}
