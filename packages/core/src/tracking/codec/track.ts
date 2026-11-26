import { deflateSync, inflateSync } from "fflate";
import type { EpochMs, Id } from "@obnixe/schema";
import { absentValue, toSampleColumns } from "../types.ts";
import type { FixColumns, HeartRateColumns, PressureColumns, SampleColumns, StepColumns, TrackerMark } from "../types.ts";
import { crc32 } from "./crc32.ts";
import { markByCode, markCodes } from "./marks.ts";
import { ByteReader, ByteWriter } from "./varint.ts";

/**
 * Immutable track `.otrk` (annex B), little-endian:
 * `OTRK`, version u8, flags u8, startedAt i64, streamCount u16, then per stream `kind u8, count u32, byteLength u32`,
 * the streams concatenated and compressed together in raw DEFLATE (level 6), and the CRC-32 of everything before it.
 *
 * Each stream stores its columns one after the other. Every column keeps the exact integer units of `SampleColumns`,
 * so that a track decodes to the very samples it was encoded from and reprocessing it is reproducible (`GPS-001`).
 * Times and step counts are unsigned LEB128 deltas, which makes their order structural; every other value is a zigzag
 * LEB128 delta, mark kinds aside. Fix columns that may be absent are only written where the fix's `presence` bit is set,
 * as deltas between present values; the orthometric altitude is stored relative to the ellipsoidal altitude of the same
 * fix when there is one, since their difference (the geoid undulation) barely changes along a track.
 */

export interface Track {
  /** `EpochMs` of `t = 0`. */
  readonly startedAt: EpochMs;
  readonly samples: SampleColumns;
  readonly marks: readonly TrackerMark[];
}

/** `recording.track_file`: the track of a recording, relative to the document directory. */
export function trackFilePath(recordingId: Id): string {
  return `tracks/${recordingId}.otrk`;
}

export class TrackDecodeError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid track: ${reason}`);
  }
}

/** The track breaks an invariant of the format, so the decoder would refuse it. */
export class TrackEncodeError extends Error {
  constructor(readonly reason: string) {
    super(`Track cannot be encoded: ${reason}`);
  }
}

const magic = [0x4f, 0x54, 0x52, 0x4b];
const trackVersion = 1;
const compressionLevel = 6;
const headerLength = 4 + 1 + 1 + 8 + 2;
const streamEntryLength = 1 + 4 + 4;
const crcLength = 4;

/** Some fix has an ellipsoidal altitude and no orthometric one: the geoid correction applies (`ELE-001`). */
const ellipsoidAltitudeFlag = 1;
const simulatedFlag = 2;

const streamKinds = { fix: 1, pressure: 2, steps: 3, heart_rate: 4, marks: 5 } as const;
type StreamKind = keyof typeof streamKinds;
const streamOrder: readonly StreamKind[] = ["fix", "pressure", "steps", "heart_rate", "marks"];

/** Smallest encoding of one entry of each stream, in bytes: one byte per column. */
const minimumEntryBytes: Readonly<Record<StreamKind, number>> = { fix: 5, pressure: 2, steps: 2, heart_rate: 3, marks: 2 };

type OptionalFixColumn = "altitudeEllipsoidMm" | "altitudeMslMm" | "horizontalAccuracyDm" | "verticalAccuracyDm" | "speedCmS" | "speedAccuracyCmS" | "bearingCentiDeg" | "bearingAccuracyCentiDeg";

/** Presence bit `i` is set when `optionalFixColumns[i]` is present; the ellipsoidal altitude comes before the orthometric one it anchors. */
const optionalFixColumns: readonly OptionalFixColumn[] = ["altitudeEllipsoidMm", "altitudeMslMm", "horizontalAccuracyDm", "verticalAccuracyDm", "speedCmS", "speedAccuracyCmS", "bearingCentiDeg", "bearingAccuracyCentiDeg"];
const isAltitude = (name: OptionalFixColumn): boolean => name === "altitudeEllipsoidMm" || name === "altitudeMslMm";
const altitudePresenceBits = 0b11;
const ellipsoidOnlyPresence = 0b01;
const simulatedPresenceBit = 1 << optionalFixColumns.length;
const presenceMask = (simulatedPresenceBit << 1) - 1;

const int32Min = -2_147_483_648;
const int32Max = 2_147_483_647;
const uint32Max = 4_294_967_295;
const uint16Max = 65_535;
const maxLatitudeE7 = 900_000_000;
const maxLongitudeE7 = 1_800_000_000;

const encodeFailure = (reason: string): TrackEncodeError => new TrackEncodeError(reason);

function writeTimes(writer: ByteWriter, t: Uint32Array, length: number, stream: StreamKind): void {
  let previous = 0;
  for (let index = 0; index < length; index += 1) {
    const value = t[index] ?? 0;
    if (value < previous) throw encodeFailure(`${stream} ${index} goes back in time`);
    writer.varUint(value - previous);
    previous = value;
  }
}

function writeDeltas(writer: ByteWriter, column: ArrayLike<number>, length: number): void {
  let previous = 0;
  for (let index = 0; index < length; index += 1) {
    const value = column[index] ?? 0;
    writer.varInt(value - previous);
    previous = value;
  }
}

const altitudeAnchor = (ellipsoid: Int32Array, index: number): number => {
  const value = ellipsoid[index] ?? absentValue;
  return value === absentValue ? 0 : value;
};

function writeFixes(writer: ByteWriter, fixes: FixColumns): void {
  const length = fixes.length;
  writeTimes(writer, fixes.t, length, "fix");
  for (let index = 0; index < length; index += 1) {
    const latitude = fixes.latitudeE7[index] ?? 0;
    const longitude = fixes.longitudeE7[index] ?? 0;
    if (Math.abs(latitude) > maxLatitudeE7 || Math.abs(longitude) > maxLongitudeE7) throw encodeFailure(`fix ${index} is out of the coordinate bounds`);
    let presence = 0;
    for (const [bit, name] of optionalFixColumns.entries()) if (fixes[name][index] !== absentValue) presence |= 1 << bit;
    const simulated = fixes.simulated[index] ?? 0;
    if (simulated > 1) throw encodeFailure(`fix ${index} has simulated = ${simulated}`);
    writer.varUint(simulated === 1 ? presence | simulatedPresenceBit : presence);
  }
  writeDeltas(writer, fixes.latitudeE7, length);
  writeDeltas(writer, fixes.longitudeE7, length);
  writeDeltas(writer, fixes.fixAgeMs, length);
  for (const name of optionalFixColumns) {
    const column = fixes[name];
    let previous = 0;
    for (let index = 0; index < length; index += 1) {
      const value = column[index] ?? absentValue;
      if (value === absentValue) continue;
      if (value < 0 && !isAltitude(name)) throw encodeFailure(`fix ${index} has a negative ${name}`);
      const stored = name === "altitudeMslMm" ? value - altitudeAnchor(fixes.altitudeEllipsoidMm, index) : value;
      writer.varInt(stored - previous);
      previous = stored;
    }
  }
}

function writePressure(writer: ByteWriter, pressure: PressureColumns): void {
  writeTimes(writer, pressure.t, pressure.length, "pressure");
  writeDeltas(writer, pressure.pascals, pressure.length);
}

function writeSteps(writer: ByteWriter, steps: StepColumns): void {
  writeTimes(writer, steps.t, steps.length, "steps");
  let previous = 0;
  for (let index = 0; index < steps.length; index += 1) {
    const count = steps.count[index] ?? 0;
    if (count < previous) throw encodeFailure(`step count ${index} decreases`);
    writer.varUint(count - previous);
    previous = count;
  }
}

function writeHeartRate(writer: ByteWriter, heartRate: HeartRateColumns): void {
  writeTimes(writer, heartRate.t, heartRate.length, "heart_rate");
  writeDeltas(writer, heartRate.bpm, heartRate.length);
  let previous = 0;
  for (let index = 0; index < heartRate.length; index += 1) {
    const stored = heartRate.rrInterval[index] ?? absentValue;
    if (stored !== absentValue && (stored <= 0 || stored > uint16Max)) throw encodeFailure(`heart rate ${index} has an RR interval of ${stored}`);
    const value = stored === absentValue ? 0 : stored;
    writer.varInt(value - previous);
    previous = value;
  }
}

function writeMarks(writer: ByteWriter, marks: readonly TrackerMark[]): void {
  let previous = 0;
  for (const [index, mark] of marks.entries()) {
    if (!Number.isInteger(mark.t) || mark.t < previous || mark.t > uint32Max) throw encodeFailure(`mark ${index} is out of order`);
    writer.varUint(mark.t - previous);
    previous = mark.t;
  }
  for (const mark of marks) writer.varUint(markCodes[mark.kind]);
}

function streamLength(track: Track, kind: StreamKind): number {
  switch (kind) {
    case "fix":
      return track.samples.fixes.length;
    case "pressure":
      return track.samples.pressure.length;
    case "steps":
      return track.samples.steps.length;
    case "heart_rate":
      return track.samples.heartRate.length;
    case "marks":
      return track.marks.length;
    default: {
      const unreachable: never = kind;
      throw new Error(`Unhandled stream ${String(unreachable)}`);
    }
  }
}

function writeStream(writer: ByteWriter, track: Track, kind: StreamKind): void {
  switch (kind) {
    case "fix":
      return writeFixes(writer, track.samples.fixes);
    case "pressure":
      return writePressure(writer, track.samples.pressure);
    case "steps":
      return writeSteps(writer, track.samples.steps);
    case "heart_rate":
      return writeHeartRate(writer, track.samples.heartRate);
    case "marks":
      return writeMarks(writer, track.marks);
    default: {
      const unreachable: never = kind;
      throw new Error(`Unhandled stream ${String(unreachable)}`);
    }
  }
}

function trackFlags(fixes: FixColumns): number {
  let flags = 0;
  for (let index = 0; index < fixes.length; index += 1) {
    if (fixes.altitudeEllipsoidMm[index] !== absentValue && fixes.altitudeMslMm[index] === absentValue) flags |= ellipsoidAltitudeFlag;
    if (fixes.simulated[index] === 1) flags |= simulatedFlag;
  }
  return flags;
}

interface StreamEntry {
  readonly kind: StreamKind;
  readonly count: number;
  readonly byteLength: number;
}

/** Encodes a track; empty streams are left out. */
export function encodeTrack(track: Track): Uint8Array {
  if (!Number.isSafeInteger(track.startedAt) || track.startedAt < 0) throw encodeFailure("startedAt is not a valid instant");
  const payload = new ByteWriter(16 * 1024);
  const entries: StreamEntry[] = [];
  for (const kind of streamOrder) {
    const count = streamLength(track, kind);
    if (count === 0) continue;
    const start = payload.size;
    writeStream(payload, track, kind);
    entries.push({ kind, count, byteLength: payload.size - start });
  }
  const compressed = deflateSync(payload.finish(), { level: compressionLevel });
  const writer = new ByteWriter(headerLength + entries.length * streamEntryLength + compressed.length + crcLength);
  writer.bytes(Uint8Array.from(magic));
  writer.u8(trackVersion);
  writer.u8(trackFlags(track.samples.fixes));
  writer.i64(track.startedAt);
  writer.u16(entries.length);
  for (const entry of entries) {
    writer.u8(streamKinds[entry.kind]);
    writer.u32(entry.count);
    writer.u32(entry.byteLength);
  }
  writer.bytes(compressed);
  writer.u32(crc32(writer.finish()));
  return writer.finish();
}

const decodeFailure = (reason: string, offset: number): TrackDecodeError => new TrackDecodeError(`${reason} at byte ${offset}`);

function readTimes(reader: ByteReader, count: number): Uint32Array {
  const t = new Uint32Array(count);
  let value = 0;
  for (let index = 0; index < count; index += 1) {
    value += reader.varUint();
    if (value > uint32Max) throw new TrackDecodeError(`time ${index} overflows`);
    t[index] = value;
  }
  return t;
}

/** Accumulates zigzag deltas into an int32 column whose values must stay within `[minimum, maximum]`. */
function readDeltas(reader: ByteReader, column: Int32Array | Uint32Array | Uint16Array, count: number, minimum: number, maximum: number, name: string): void {
  let value = 0;
  for (let index = 0; index < count; index += 1) {
    value += reader.varInt();
    if (value < minimum || value > maximum) throw new TrackDecodeError(`${name} ${index} is out of range`);
    column[index] = value;
  }
}

interface DecodedFixes {
  readonly columns: FixColumns;
  readonly flags: number;
}

function readFixes(reader: ByteReader, count: number): DecodedFixes {
  const t = readTimes(reader, count);
  const presence = new Uint16Array(count);
  for (let index = 0; index < count; index += 1) {
    const bits = reader.varUint();
    if (bits > presenceMask) throw new TrackDecodeError(`fix ${index} has unknown presence bits`);
    presence[index] = bits;
  }
  const latitudeE7 = new Int32Array(count);
  const longitudeE7 = new Int32Array(count);
  readDeltas(reader, latitudeE7, count, -maxLatitudeE7, maxLatitudeE7, "latitude");
  readDeltas(reader, longitudeE7, count, -maxLongitudeE7, maxLongitudeE7, "longitude");
  const fixAgeMs = new Int32Array(count);
  readDeltas(reader, fixAgeMs, count, int32Min, int32Max, "fix age");
  const optional = {} as Record<OptionalFixColumn, Int32Array>;
  for (const [bit, name] of optionalFixColumns.entries()) {
    const column = new Int32Array(count).fill(absentValue);
    const minimum = isAltitude(name) ? -int32Max : 0;
    let stored = 0;
    for (let index = 0; index < count; index += 1) {
      if (((presence[index] ?? 0) & (1 << bit)) === 0) continue;
      stored += reader.varInt();
      const value = name === "altitudeMslMm" ? stored + altitudeAnchor(optional.altitudeEllipsoidMm, index) : stored;
      if (value < minimum || value > int32Max) throw new TrackDecodeError(`${name} ${index} is out of range`);
      column[index] = value;
    }
    optional[name] = column;
  }
  const simulated = new Uint8Array(count);
  let flags = 0;
  for (let index = 0; index < count; index += 1) {
    const bits = presence[index] ?? 0;
    if ((bits & simulatedPresenceBit) !== 0) {
      simulated[index] = 1;
      flags |= simulatedFlag;
    }
    if ((bits & altitudePresenceBits) === ellipsoidOnlyPresence) flags |= ellipsoidAltitudeFlag;
  }
  return { columns: { length: count, t, fixAgeMs, latitudeE7, longitudeE7, ...optional, simulated }, flags };
}

function readPressure(reader: ByteReader, count: number): PressureColumns {
  const t = readTimes(reader, count);
  const pascals = new Uint32Array(count);
  readDeltas(reader, pascals, count, 0, uint32Max, "pressure");
  return { length: count, t, pascals };
}

function readSteps(reader: ByteReader, count: number): StepColumns {
  const t = readTimes(reader, count);
  const total = new Uint32Array(count);
  let value = 0;
  for (let index = 0; index < count; index += 1) {
    value += reader.varUint();
    if (value > uint32Max) throw new TrackDecodeError(`step count ${index} overflows`);
    total[index] = value;
  }
  return { length: count, t, count: total };
}

function readHeartRate(reader: ByteReader, count: number): HeartRateColumns {
  const t = readTimes(reader, count);
  const bpm = new Uint16Array(count);
  readDeltas(reader, bpm, count, 0, uint16Max, "heart rate");
  const rrInterval = new Int32Array(count);
  readDeltas(reader, rrInterval, count, 0, uint16Max, "RR interval");
  for (let index = 0; index < count; index += 1) if (rrInterval[index] === 0) rrInterval[index] = absentValue;
  return { length: count, t, bpm, rrInterval };
}

function readMarks(reader: ByteReader, count: number): TrackerMark[] {
  const t = readTimes(reader, count);
  const marks: TrackerMark[] = [];
  for (let index = 0; index < count; index += 1) {
    const kind = markByCode[reader.varUint()];
    if (kind === undefined) throw new TrackDecodeError(`mark ${index} has an unknown kind`);
    marks.push({ kind, t: t[index] ?? 0 });
  }
  return marks;
}

function inflate(compressed: Uint8Array, expectedLength: number): Uint8Array {
  let inflated: Uint8Array;
  try {
    inflated = inflateSync(compressed, { out: new Uint8Array(expectedLength + 1) });
  } catch (error) {
    if (error instanceof Error && "code" in error) throw new TrackDecodeError(`payload does not inflate: ${error.message}`);
    throw error;
  }
  if (inflated.length !== expectedLength) throw new TrackDecodeError(`payload inflates to ${inflated.length} bytes instead of ${expectedLength}`);
  return inflated;
}

/**
 * Strict decoder (`DAT-040`): checks the magic, version, flags, CRC, every length, the time order of each stream and the
 * coordinate bounds, and decodes straight into typed columns (`PRF-031`).
 */
export function decodeTrack(bytes: Uint8Array): Track {
  const header = new ByteReader(bytes, decodeFailure);
  if (bytes.length < headerLength + crcLength) throw new TrackDecodeError("file too short");
  for (const byte of magic) if (header.u8() !== byte) throw new TrackDecodeError("not a track file");
  const version = header.u8();
  if (version !== trackVersion) throw new TrackDecodeError(`unsupported version ${version}`);
  const flags = header.u8();
  if ((flags & ~(ellipsoidAltitudeFlag | simulatedFlag)) !== 0) throw new TrackDecodeError("unknown flags");
  const startedAt = header.i64();
  if (startedAt < 0) throw new TrackDecodeError("negative startedAt");
  const streamCount = header.u16();
  const payloadStart = headerLength + streamCount * streamEntryLength;
  if (payloadStart + crcLength > bytes.length) throw new TrackDecodeError("stream table truncated");
  const crcOffset = bytes.length - crcLength;
  if (crc32(bytes, 0, crcOffset) !== new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(crcOffset, true)) throw new TrackDecodeError("CRC mismatch");
  const entries: StreamEntry[] = [];
  let previousKind = 0;
  let totalLength = 0;
  for (let index = 0; index < streamCount; index += 1) {
    const code = header.u8();
    const kind = streamOrder.find((candidate) => streamKinds[candidate] === code);
    if (kind === undefined) throw new TrackDecodeError(`unknown stream kind ${code}`);
    if (code <= previousKind) throw new TrackDecodeError("streams are not in strictly increasing kind order");
    previousKind = code;
    const count = header.u32();
    const byteLength = header.u32();
    if (count === 0 || byteLength < count * minimumEntryBytes[kind]) throw new TrackDecodeError(`${kind} stream length does not match its count`);
    totalLength += byteLength;
    entries.push({ kind, count, byteLength });
  }
  const payload = inflate(bytes.subarray(payloadStart, crcOffset), totalLength);
  let { fixes, pressure, steps, heartRate } = toSampleColumns([]);
  let marks: TrackerMark[] = [];
  let fixFlags = 0;
  let offset = 0;
  for (const entry of entries) {
    const reader = new ByteReader(payload, decodeFailure, offset, offset + entry.byteLength);
    switch (entry.kind) {
      case "fix": {
        const decoded = readFixes(reader, entry.count);
        fixes = decoded.columns;
        fixFlags = decoded.flags;
        break;
      }
      case "pressure":
        pressure = readPressure(reader, entry.count);
        break;
      case "steps":
        steps = readSteps(reader, entry.count);
        break;
      case "heart_rate":
        heartRate = readHeartRate(reader, entry.count);
        break;
      case "marks":
        marks = readMarks(reader, entry.count);
        break;
      default: {
        const unreachable: never = entry.kind;
        throw new Error(`Unhandled stream ${String(unreachable)}`);
      }
    }
    if (reader.remaining !== 0) throw new TrackDecodeError(`${entry.kind} stream has ${reader.remaining} trailing bytes`);
    offset += entry.byteLength;
  }
  if (fixFlags !== flags) throw new TrackDecodeError("flags do not match the fixes");
  return { startedAt: startedAt as EpochMs, samples: { fixes, pressure, steps, heartRate }, marks };
}
