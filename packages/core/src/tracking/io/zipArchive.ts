import { Inflate, inflateSync } from "fflate";
import { decodeUtf8, InvalidUtf8Error } from "../../data/utf8.ts";
import { crc32, crc32Update } from "../codec/crc32.ts";

/** Random access to a large file, a range at a time: an account archive can exceed 1 GB and is never loaded whole (`IO-021`). */
export interface ArchiveSource {
  readonly size: number;
  /** The `length` bytes at `offset`; fewer only past the end of the file. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Yields to the interface between two pieces of work (`IO-026`). */
export type Pace = () => Promise<void>;

export const archiveErrorReasons = ["not_a_zip", "malformed", "truncated", "encrypted", "unsupported_compression", "checksum", "too_large", "not_an_account_archive"] as const;
export type ArchiveErrorReason = (typeof archiveErrorReasons)[number];

/** An archive, or an entry of it, that cannot be read. */
export class ArchiveError extends Error {
  constructor(
    readonly reason: ArchiveErrorReason,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

/** An entry of a ZIP central directory. */
export interface ZipEntry {
  readonly path: string;
  readonly method: number;
  readonly flags: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly headerOffset: number;
}

/** Compressed bytes read per call when an entry is streamed. */
export const archiveChunkBytes = 1024 * 1024;

const storedMethod = 0;
const deflatedMethod = 8;
const encryptedFlag = 0x1;
const endSignature = 0x06054b50;
const zip64LocatorSignature = 0x07064b50;
const zip64EndSignature = 0x06064b50;
const centralSignature = 0x02014b50;
const localSignature = 0x04034b50;
const zip64ExtraId = 0x0001;
const endLength = 22;
const zip64LocatorLength = 20;
const zip64EndLength = 56;
const centralLength = 46;
const localLength = 30;
const maxCommentLength = 0xffff;
const u16Max = 0xffff;
const u32Max = 0xffffffff;
const maxDirectoryBytes = 64 * 1024 * 1024;

const u16 = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u32 = (bytes: Uint8Array, at: number): number => u16(bytes, at) + u16(bytes, at + 2) * 0x1_0000;

function u64(bytes: Uint8Array, at: number): number {
  const value = u32(bytes, at) + u32(bytes, at + 4) * 0x1_0000_0000;
  if (!Number.isSafeInteger(value)) throw new ArchiveError("too_large", "a ZIP64 size or offset exceeds 2^53");
  return value;
}

export const isZipDirectory = (entry: ZipEntry): boolean => entry.path.endsWith("/");

async function readExactly(source: ArchiveSource, offset: number, length: number, what: string): Promise<Uint8Array> {
  if (offset < 0 || offset + length > source.size) throw new ArchiveError("truncated", `${what} lies past the end of the archive`);
  const bytes = await source.read(offset, length);
  if (bytes.length !== length) throw new ArchiveError("truncated", `${what} is cut short`);
  return bytes;
}

interface CentralDirectory {
  readonly offset: number;
  readonly size: number;
  readonly entries: number;
}

function endRecordAt(tail: Uint8Array): number {
  for (let at = tail.length - endLength; at >= 0; at -= 1) {
    if (u32(tail, at) === endSignature && at + endLength + u16(tail, at + 20) <= tail.length) return at;
  }
  return -1;
}

async function locateDirectory(source: ArchiveSource): Promise<CentralDirectory> {
  if (source.size < endLength) throw new ArchiveError("not_a_zip", "the file is too short for a ZIP archive");
  const tailLength = Math.min(source.size, endLength + maxCommentLength + zip64LocatorLength);
  const tail = await readExactly(source, source.size - tailLength, tailLength, "the end of the archive");
  const end = endRecordAt(tail);
  if (end < 0) throw new ArchiveError("not_a_zip", "the file has no end of central directory record");
  const entries = u16(tail, end + 10);
  const size = u32(tail, end + 12);
  const offset = u32(tail, end + 16);
  if (entries !== u16Max && size !== u32Max && offset !== u32Max) return { offset, size, entries };
  const locator = end - zip64LocatorLength;
  if (locator < 0 || u32(tail, locator) !== zip64LocatorSignature) throw new ArchiveError("malformed", "the ZIP64 end of central directory locator is missing");
  const record = await readExactly(source, u64(tail, locator + 8), zip64EndLength, "the ZIP64 end of central directory");
  if (u32(record, 0) !== zip64EndSignature) throw new ArchiveError("malformed", "the ZIP64 end of central directory record is invalid");
  return { entries: u64(record, 32), size: u64(record, 40), offset: u64(record, 48) };
}

interface ExtraField {
  readonly start: number;
  readonly end: number;
}

function zip64Field(bytes: Uint8Array, start: number, end: number): ExtraField | null {
  for (let at = start; at + 4 <= end; at += 4 + u16(bytes, at + 2)) {
    if (u16(bytes, at) === zip64ExtraId) return { start: at + 4, end: Math.min(at + 4 + u16(bytes, at + 2), end) };
  }
  return null;
}

/** UTF-8 names, flagged or not as many tools write them; other bytes read one character each, as the CP437 ASCII range. */
function entryName(bytes: Uint8Array): string {
  try {
    return decodeUtf8(bytes);
  } catch (error) {
    if (!(error instanceof InvalidUtf8Error)) throw error;
    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  }
}

/** The central directory of a ZIP archive, ZIP64 included, read from its end without reading the entries. */
export async function readZipDirectory(source: ArchiveSource): Promise<readonly ZipEntry[]> {
  const directory = await locateDirectory(source);
  if (directory.size > maxDirectoryBytes) throw new ArchiveError("too_large", "the central directory is too large");
  const bytes = await readExactly(source, directory.offset, directory.size, "the central directory");
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let index = 0; index < directory.entries; index += 1) {
    if (at + centralLength > bytes.length || u32(bytes, at) !== centralSignature) throw new ArchiveError("malformed", `central directory entry ${index} is invalid`);
    const nameStart = at + centralLength;
    const extraStart = nameStart + u16(bytes, at + 28);
    const extraEnd = extraStart + u16(bytes, at + 30);
    const next = extraEnd + u16(bytes, at + 32);
    if (next > bytes.length) throw new ArchiveError("malformed", `central directory entry ${index} overruns the directory`);
    let compressedSize = u32(bytes, at + 20);
    let size = u32(bytes, at + 24);
    let headerOffset = u32(bytes, at + 42);
    if (size === u32Max || compressedSize === u32Max || headerOffset === u32Max) {
      const field = zip64Field(bytes, extraStart, extraEnd);
      if (field === null) throw new ArchiveError("malformed", `central directory entry ${index} lacks its ZIP64 sizes`);
      let cursor = field.start;
      const take = (): number => {
        if (cursor + 8 > field.end) throw new ArchiveError("malformed", `central directory entry ${index} has a short ZIP64 field`);
        const value = u64(bytes, cursor);
        cursor += 8;
        return value;
      };
      if (size === u32Max) size = take();
      if (compressedSize === u32Max) compressedSize = take();
      if (headerOffset === u32Max) headerOffset = take();
    }
    entries.push({ path: entryName(bytes.subarray(nameStart, extraStart)), method: u16(bytes, at + 10), flags: u16(bytes, at + 8), crc: u32(bytes, at + 16), compressedSize, size, headerOffset });
    at = next;
  }
  return entries;
}

function checkReadable(entry: ZipEntry): void {
  if ((entry.flags & encryptedFlag) !== 0) throw new ArchiveError("encrypted", `${entry.path} is encrypted`);
  if (entry.method !== storedMethod && entry.method !== deflatedMethod) throw new ArchiveError("unsupported_compression", `${entry.path} uses compression method ${entry.method}`);
}

async function dataOffset(source: ArchiveSource, entry: ZipEntry): Promise<number> {
  const header = await readExactly(source, entry.headerOffset, localLength, `the local header of ${entry.path}`);
  if (u32(header, 0) !== localSignature) throw new ArchiveError("malformed", `the local header of ${entry.path} is invalid`);
  return entry.headerOffset + localLength + u16(header, 26) + u16(header, 28);
}

function inflateError(entry: ZipEntry, error: unknown): unknown {
  return error instanceof Error && "code" in error ? new ArchiveError("malformed", `${entry.path} cannot be inflated: ${error.message}`) : error;
}

/** One entry read whole and checked against its size and CRC; refused above `maxBytes` before anything is read. */
export async function readZipEntry(source: ArchiveSource, entry: ZipEntry, maxBytes: number): Promise<Uint8Array> {
  checkReadable(entry);
  if (entry.size > maxBytes) throw new ArchiveError("too_large", `${entry.path} is too large`);
  const raw = await readExactly(source, await dataOffset(source, entry), entry.compressedSize, entry.path);
  let content = raw;
  if (entry.method === deflatedMethod) {
    try {
      content = inflateSync(raw, { out: new Uint8Array(entry.size) });
    } catch (error) {
      throw inflateError(entry, error);
    }
  }
  if (content.length !== entry.size || crc32(content) !== entry.crc) throw new ArchiveError("checksum", `${entry.path} does not match its checksum`);
  return content;
}

/** A stored entry as a source of its own, such as an archive kept uncompressed inside another; `null` for a compressed entry. */
export async function storedEntrySource(source: ArchiveSource, entry: ZipEntry): Promise<ArchiveSource | null> {
  checkReadable(entry);
  if (entry.method !== storedMethod) return null;
  const offset = await dataOffset(source, entry);
  if (offset + entry.size > source.size) throw new ArchiveError("truncated", `${entry.path} lies past the end of the archive`);
  return { size: entry.size, read: (at, length) => source.read(offset + at, Math.max(Math.min(length, entry.size - at), 0)) };
}

/**
 * Streams an entry of any size in chunks of `archiveChunkBytes` compressed bytes, inflated on the way and checked against its
 * size and CRC at the end; `write` also receives the compressed bytes read so far.
 */
export async function streamZipEntry(source: ArchiveSource, entry: ZipEntry, write: (chunk: Uint8Array, compressedRead: number) => Promise<void>, pace: Pace): Promise<void> {
  checkReadable(entry);
  const start = await dataOffset(source, entry);
  const produced: Uint8Array[] = [];
  const inflater = entry.method === deflatedMethod ? new Inflate((data) => produced.push(data)) : null;
  let read = 0;
  let size = 0;
  let crc = 0;
  do {
    const length = Math.min(archiveChunkBytes, entry.compressedSize - read);
    const chunk = await readExactly(source, start + read, length, entry.path);
    read += length;
    if (inflater === null) produced.push(chunk);
    else {
      try {
        inflater.push(chunk, read === entry.compressedSize);
      } catch (error) {
        throw inflateError(entry, error);
      }
    }
    for (const part of produced.splice(0)) {
      size += part.length;
      if (size > entry.size) throw new ArchiveError("checksum", `${entry.path} inflates past its size`);
      crc = crc32Update(crc, part);
      await write(part, read);
    }
    await pace();
  } while (read < entry.compressedSize);
  if (size !== entry.size || crc !== entry.crc) throw new ArchiveError("checksum", `${entry.path} does not match its checksum`);
}
