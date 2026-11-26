import type { EpochMs, Id } from "@obnixe/schema";
import { decodeUtf8, encodeUtf8, InvalidUtf8Error } from "../../data/utf8.ts";
import type { Fix, HeartRateContact, Sample, TrackerMark } from "../types.ts";
import { crc32 } from "./crc32.ts";
import { markByCode, markCodes } from "./marks.ts";
import { ByteWriter } from "./varint.ts";

/**
 * Raw journal `.ojr` (annex C, byte contract shared with the native writers): a header, then append-only batches,
 * each closed by a CRC-32 and synced to disk (`REC-080`). All integers are little-endian.
 */

const magic = [0x4f, 0x4a, 0x52, 0x4e];
const journalVersion = 1;
/** magic, version, sessionId, t0, m0, platform, device length. */
const headerFixedLength = 4 + 1 + 16 + 8 + 8 + 1 + 1;
const batchPrefixLength = 8;
const crcLength = 4;
const int32Min = -2_147_483_648;
const u16Absent = 0xffff;
const u16Max = 0xfffe;
const rrAbsent = 0;
const simulatedFlag = 1;
const maxLatitudeE7 = 900_000_000;
const maxLongitudeE7 = 1_800_000_000;

const recordType = { fix: 1, pressure: 2, steps: 3, heart_rate: 4, mark: 5, power: 6, cadence: 7 } as const;
const recordLength: Readonly<Record<number, number>> = { 1: 38, 2: 9, 3: 9, 4: 10, 5: 6, 6: 9, 7: 7 };

const platformCodes = { android: 1, ios: 2 } as const;
export type JournalPlatform = keyof typeof platformCodes;

const contactCodes: Readonly<Record<HeartRateContact, number>> = { absent: 0, contact: 1, unsupported: 2 };
const contactByCode: readonly HeartRateContact[] = ["absent", "contact", "unsupported"];
export interface JournalHeader {
  readonly sessionId: Id;
  /** `t0`: the instant of `t = 0` for every record (`GPS-012`). */
  readonly startedAt: EpochMs;
  /** `m0`: the monotonic clock reading captured together with `t0`. */
  readonly monotonicOriginNs: bigint;
  readonly platform: JournalPlatform;
  readonly device: string;
}

export interface JournalMark extends TrackerMark {
  readonly type: "mark";
}

export type JournalRecord = Sample | JournalMark;

export interface JournalContents {
  /** `null` when the file ends before its header is complete: the writer died while creating it, nothing was recorded. */
  readonly header: JournalHeader | null;
  /** Samples of the valid batches, in journal order; each stream is ordered by `t`. */
  readonly samples: readonly Sample[];
  readonly marks: readonly TrackerMark[];
  /** Sequence of the last valid batch, `null` when there is none. */
  readonly lastSequence: number | null;
  /** Bytes covered by the header and the valid batches; everything after them is ignored. */
  readonly validLength: number;
}

export interface ReadJournalOptions {
  /** Only return the records of batches after this sequence (re-read after a batch lost by the bridge). */
  readonly afterSequence?: number;
}

export type JournalCorruption = "magic" | "version" | "header_crc" | "started_at" | "platform" | "device";

/** The header is unusable; a damaged batch is not an error, reading just stops before it (`REC-080`). */
export class JournalCorruptedError extends Error {
  constructor(readonly corruption: JournalCorruption) {
    super(`Corrupted journal: ${corruption}`);
  }
}

function idFromBytes(bytes: Uint8Array): Id {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as Id;
}

function idToBytes(id: Id): Uint8Array {
  const hex = id.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

const readI64 = (view: DataView, offset: number): number => view.getInt32(offset + 4, true) * 2 ** 32 + view.getUint32(offset, true);

const readBigInt64 = (view: DataView, offset: number): bigint => (BigInt(view.getInt32(offset + 4, true)) << 32n) + BigInt(view.getUint32(offset, true));

interface ParsedHeader {
  readonly header: JournalHeader;
  readonly length: number;
}

function readHeader(bytes: Uint8Array, view: DataView): ParsedHeader | null {
  for (let index = 0; index < Math.min(magic.length, bytes.length); index += 1) {
    if (bytes[index] !== magic[index]) throw new JournalCorruptedError("magic");
  }
  if (bytes.length > 4 && bytes[4] !== journalVersion) throw new JournalCorruptedError("version");
  if (bytes.length < headerFixedLength) return null;
  const deviceLength = view.getUint8(headerFixedLength - 1);
  const length = headerFixedLength + deviceLength + crcLength;
  if (bytes.length < length) return null;
  if (crc32(bytes, 0, length - crcLength) !== view.getUint32(length - crcLength, true)) throw new JournalCorruptedError("header_crc");
  const platformCode = view.getUint8(37);
  const platform = platformCode === platformCodes.android ? "android" : platformCode === platformCodes.ios ? "ios" : null;
  if (platform === null) throw new JournalCorruptedError("platform");
  const startedAt = readI64(view, 21);
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new JournalCorruptedError("started_at");
  let device: string;
  try {
    device = decodeUtf8(bytes.subarray(headerFixedLength, headerFixedLength + deviceLength));
  } catch (error) {
    if (error instanceof InvalidUtf8Error) throw new JournalCorruptedError("device");
    throw error;
  }
  return {
    header: { sessionId: idFromBytes(bytes.subarray(5, 21)), startedAt: startedAt as EpochMs, monotonicOriginNs: readBigInt64(view, 29), platform, device },
    length,
  };
}

const optionalI32 = (value: number): number | null => (value === int32Min ? null : value);
const optionalU16 = (value: number): number | null => (value === u16Absent ? null : value);

function readFix(view: DataView, at: number): Fix | null {
  const latitudeE7 = view.getInt32(at + 9, true);
  const longitudeE7 = view.getInt32(at + 13, true);
  const flags = view.getUint8(at + 37);
  if (Math.abs(latitudeE7) > maxLatitudeE7 || Math.abs(longitudeE7) > maxLongitudeE7 || (flags & ~simulatedFlag) !== 0) return null;
  return {
    type: "fix",
    t: view.getUint32(at + 1, true),
    fixAgeMs: view.getInt32(at + 5, true),
    latitudeE7,
    longitudeE7,
    altitudeEllipsoidMm: optionalI32(view.getInt32(at + 17, true)),
    altitudeMslMm: optionalI32(view.getInt32(at + 21, true)),
    horizontalAccuracyDm: optionalU16(view.getUint16(at + 25, true)),
    verticalAccuracyDm: optionalU16(view.getUint16(at + 27, true)),
    speedCmS: optionalU16(view.getUint16(at + 29, true)),
    speedAccuracyCmS: optionalU16(view.getUint16(at + 31, true)),
    bearingCentiDeg: optionalU16(view.getUint16(at + 33, true)),
    bearingAccuracyCentiDeg: optionalU16(view.getUint16(at + 35, true)),
    simulated: (flags & simulatedFlag) !== 0,
  };
}

function readRecord(view: DataView, at: number, type: number): JournalRecord | null {
  const t = view.getUint32(at + 1, true);
  switch (type) {
    case recordType.fix:
      return readFix(view, at);
    case recordType.pressure:
      return { type: "pressure", t, pascals: view.getUint32(at + 5, true) };
    case recordType.steps:
      return { type: "steps", t, count: view.getUint32(at + 5, true) };
    case recordType.heart_rate: {
      const contact = contactByCode[view.getUint8(at + 7)];
      if (contact === undefined) return null;
      const rr = view.getUint16(at + 8, true);
      return { type: "heart_rate", t, bpm: view.getUint16(at + 5, true), contact, rrInterval: rr === rrAbsent ? null : rr };
    }
    case recordType.mark: {
      const kind = markByCode[view.getUint8(at + 5)];
      return kind === undefined ? null : { type: "mark", kind, t };
    }
    case recordType.power:
      return { type: "power", t, watts: view.getUint16(at + 5, true), cadence: optionalU16(view.getUint16(at + 7, true)) };
    case recordType.cadence:
      return { type: "cadence", t, perMinute: view.getUint16(at + 5, true) };
    default:
      return null;
  }
}

/** Last `t` seen per stream, so that a batch going back in time in one of its streams is rejected as a whole. */
type StreamClock = Record<JournalRecord["type"], number>;

/** The records of a CRC-valid batch, or `null` when they do not exactly fill it or break a stream's time order. */
function readBatchRecords(bytes: Uint8Array, view: DataView, start: number, end: number, clock: StreamClock): JournalRecord[] | null {
  const records: JournalRecord[] = [];
  const next: StreamClock = { ...clock };
  let at = start;
  while (at < end) {
    const type = bytes[at] ?? 0;
    const length = recordLength[type];
    if (length === undefined || at + length > end) return null;
    const record = readRecord(view, at, type);
    if (record === null || record.t < next[record.type]) return null;
    next[record.type] = record.t;
    records.push(record);
    at += length;
  }
  Object.assign(clock, next);
  return records;
}

/**
 * Reads every complete batch of a journal. Reading stops, without error, at the first batch that overruns the file,
 * fails its CRC, breaks the sequence or holds malformed records: that batch and everything after it are ignored (`REC-080`).
 */
export function readJournal(bytes: Uint8Array, options: ReadJournalOptions = {}): JournalContents {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parsed = readHeader(bytes, view);
  if (parsed === null) return { header: null, samples: [], marks: [], lastSequence: null, validLength: 0 };
  const afterSequence = options.afterSequence ?? -1;
  const samples: Sample[] = [];
  const marks: TrackerMark[] = [];
  const clock: StreamClock = { fix: 0, pressure: 0, steps: 0, heart_rate: 0, cadence: 0, power: 0, mark: 0 };
  let lastSequence: number | null = null;
  let offset = parsed.length;
  while (bytes.length - offset >= batchPrefixLength) {
    const length = view.getUint32(offset, true);
    const sequence = view.getUint32(offset + 4, true);
    const recordsEnd = offset + batchPrefixLength + length;
    if (length === 0 || recordsEnd + crcLength > bytes.length) break;
    if (sequence !== (lastSequence ?? -1) + 1) break;
    if (crc32(bytes, offset, recordsEnd) !== view.getUint32(recordsEnd, true)) break;
    const records = readBatchRecords(bytes, view, offset + batchPrefixLength, recordsEnd, clock);
    if (records === null) break;
    if (sequence > afterSequence) {
      for (const record of records) {
        if (record.type === "mark") marks.push({ kind: record.kind, t: record.t });
        else samples.push(record);
      }
    }
    lastSequence = sequence;
    offset = recordsEnd + crcLength;
  }
  return { header: parsed.header, samples, marks, lastSequence, validLength: offset };
}

export function encodeJournalHeader(header: JournalHeader): Uint8Array {
  const device = encodeUtf8(header.device);
  if (device.length > 0xff) throw new RangeError("Journal device names are limited to 255 UTF-8 bytes");
  const writer = new ByteWriter(headerFixedLength + device.length + crcLength);
  writer.bytes(Uint8Array.from(magic));
  writer.u8(journalVersion);
  writer.bytes(idToBytes(header.sessionId));
  writer.i64(header.startedAt);
  writer.bigInt64(header.monotonicOriginNs);
  writer.u8(platformCodes[header.platform]);
  writer.u8(device.length);
  writer.bytes(device);
  const bytes = writer.finish();
  writer.u32(crc32(bytes));
  return writer.finish();
}

const u16OrAbsent = (value: number | null): number => (value === null ? u16Absent : Math.min(value, u16Max));

function writeRecord(writer: ByteWriter, record: JournalRecord): void {
  switch (record.type) {
    case "fix":
      writer.u8(recordType.fix);
      writer.u32(record.t);
      writer.i32(record.fixAgeMs);
      writer.i32(record.latitudeE7);
      writer.i32(record.longitudeE7);
      writer.i32(record.altitudeEllipsoidMm ?? int32Min);
      writer.i32(record.altitudeMslMm ?? int32Min);
      writer.u16(u16OrAbsent(record.horizontalAccuracyDm));
      writer.u16(u16OrAbsent(record.verticalAccuracyDm));
      writer.u16(u16OrAbsent(record.speedCmS));
      writer.u16(u16OrAbsent(record.speedAccuracyCmS));
      writer.u16(u16OrAbsent(record.bearingCentiDeg));
      writer.u16(u16OrAbsent(record.bearingAccuracyCentiDeg));
      writer.u8(record.simulated ? simulatedFlag : 0);
      return;
    case "pressure":
      writer.u8(recordType.pressure);
      writer.u32(record.t);
      writer.u32(record.pascals);
      return;
    case "steps":
      writer.u8(recordType.steps);
      writer.u32(record.t);
      writer.u32(record.count);
      return;
    case "heart_rate":
      writer.u8(recordType.heart_rate);
      writer.u32(record.t);
      writer.u16(record.bpm);
      writer.u8(contactCodes[record.contact]);
      writer.u16(record.rrInterval ?? rrAbsent);
      return;
    case "mark":
      writer.u8(recordType.mark);
      writer.u32(record.t);
      writer.u8(markCodes[record.kind]);
      return;
    case "power":
      writer.u8(recordType.power);
      writer.u32(record.t);
      writer.u16(Math.min(record.watts, u16Max));
      writer.u16(u16OrAbsent(record.cadence));
      return;
    case "cadence":
      writer.u8(recordType.cadence);
      writer.u32(record.t);
      writer.u16(Math.min(record.perMinute, u16Max));
      return;
    default: {
      const unreachable: never = record;
      throw new Error(`Unhandled journal record ${JSON.stringify(unreachable)}`);
    }
  }
}

/** One batch as the native writers append it; used to build journals in tests and replays. */
export function encodeJournalBatch(sequence: number, records: readonly JournalRecord[]): Uint8Array {
  if (records.length === 0) throw new RangeError("Journal batches are never empty");
  const writer = new ByteWriter(batchPrefixLength + records.length * 38 + crcLength);
  writer.u32(0);
  writer.u32(sequence);
  for (const record of records) writeRecord(writer, record);
  writer.patchU32(0, writer.size - batchPrefixLength);
  writer.u32(crc32(writer.finish()));
  return writer.finish();
}
