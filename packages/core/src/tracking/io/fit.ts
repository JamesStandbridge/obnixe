import { decodeUtf8, InvalidUtf8Error } from "../../data/utf8.ts";
import { assembleActivity } from "./activity.ts";
import type { FilePoint, FileTimerEvent, FileTotals, ImportedActivity, PoolSwim } from "./activity.ts";
import { ImportError } from "./errors.ts";
import { fitSport, sportOfFit } from "./sports.ts";
import { contentId } from "./values.ts";

/** Seconds from the Unix epoch to the FIT epoch, 1989-12-31T00:00:00Z. */
const fitEpochSeconds = 631_065_600;
const semicircleDegrees = 180 / 2 ** 31;
const maxSemicircleLatitude = 2 ** 30;

const message = { fileId: 0, sport: 12, session: 18, lap: 19, record: 20, event: 21, deviceInfo: 23, length: 101 } as const;
const fileTypeActivity = 4;
const eventTimer = 0;
const eventType = { start: 0, stop: 1, stopAll: 4, stopDisable: 8, stopDisableAll: 9 } as const;
const lengthTypeActive = 1;
const displayMeasureStatute = 1;
const yardMeters = 0.9144;
const timestampField = 253;

const manufacturers: Readonly<Record<number, string>> = { 1: "Garmin", 23: "Suunto", 32: "Wahoo", 123: "Polar", 294: "Coros" };
const garmin = 1;
const garminProducts: Readonly<Record<number, string>> = { 4257: "Forerunner 265", 4258: "Forerunner 265S", 4260: "Venu 3", 4261: "Venu 3S", 4315: "Forerunner 965" };

/** Size in bytes and invalid value of each FIT base type, by its number (low 5 bits). */
const baseTypes: readonly { readonly size: number; readonly invalid: number | null }[] = [
  { size: 1, invalid: 0xff },
  { size: 1, invalid: 0x7f },
  { size: 1, invalid: 0xff },
  { size: 2, invalid: 0x7fff },
  { size: 2, invalid: 0xffff },
  { size: 4, invalid: 0x7fffffff },
  { size: 4, invalid: 0xffffffff },
  { size: 1, invalid: null },
  { size: 4, invalid: null },
  { size: 8, invalid: null },
  { size: 1, invalid: 0 },
  { size: 2, invalid: 0 },
  { size: 4, invalid: 0 },
  { size: 1, invalid: 0xff },
  { size: 8, invalid: null },
  { size: 8, invalid: null },
  { size: 8, invalid: null },
];
const stringType = 7;

const crcTable = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

export function fitCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index] ?? 0;
    let low = crcTable[crc & 0xf] ?? 0;
    crc = ((crc >> 4) & 0x0fff) ^ low ^ (crcTable[byte & 0xf] ?? 0);
    low = crcTable[crc & 0xf] ?? 0;
    crc = ((crc >> 4) & 0x0fff) ^ low ^ (crcTable[(byte >> 4) & 0xf] ?? 0);
  }
  return crc;
}

interface FieldDefinition {
  readonly number: number;
  readonly offset: number;
  readonly size: number;
  readonly baseType: number;
}

interface MessageDefinition {
  readonly global: number;
  readonly littleEndian: boolean;
  readonly fields: readonly FieldDefinition[];
  readonly size: number;
}

/** One decoded message: the first value of each valid field, by field number; strings separately. */
class FieldValues {
  constructor(
    private readonly view: DataView,
    private readonly start: number,
    private readonly definition: MessageDefinition,
  ) {}

  number(field: number): number | null {
    const definition = this.definition.fields.find((candidate) => candidate.number === field);
    if (definition === undefined || definition.baseType === stringType) return null;
    const type = baseTypes[definition.baseType];
    if (type === undefined || type.size > definition.size || type.size > 4) return null;
    const at = this.start + definition.offset;
    const little = this.definition.littleEndian;
    let value: number;
    switch (definition.baseType) {
      case 1:
        value = this.view.getInt8(at);
        break;
      case 3:
        value = this.view.getInt16(at, little);
        break;
      case 4:
      case 11:
        value = this.view.getUint16(at, little);
        break;
      case 5:
        value = this.view.getInt32(at, little);
        break;
      case 6:
      case 12:
        value = this.view.getUint32(at, little);
        break;
      case 8: {
        const float = this.view.getFloat32(at, little);
        return Number.isFinite(float) ? float : null;
      }
      default:
        value = this.view.getUint8(at);
    }
    return value === type.invalid ? null : value;
  }

  string(field: number): string | null {
    const definition = this.definition.fields.find((candidate) => candidate.number === field && candidate.baseType === stringType);
    if (definition === undefined) return null;
    const at = this.start + definition.offset;
    let end = at;
    while (end < at + definition.size && this.view.getUint8(end) !== 0) end += 1;
    if (end === at) return null;
    try {
      return decodeUtf8(new Uint8Array(this.view.buffer, this.view.byteOffset + at, end - at)).trim() || null;
    } catch (error) {
      if (error instanceof InvalidUtf8Error) return null;
      throw error;
    }
  }
}

interface FitSession {
  readonly startTime: number | null;
  readonly sport: number | null;
  readonly subSport: number | null;
  readonly totals: FileTotals;
  readonly poolLengthMeters: number | null;
  readonly activeLengths: number | null;
}

interface FitFile {
  fileType: number | null;
  identity: string | null;
  device: string | null;
  creator: string | null;
  sport: number | null;
  subSport: number | null;
  readonly sessions: FitSession[];
  readonly points: FilePoint[];
  readonly timer: FileTimerEvent[];
  readonly lapStarts: number[];
  activeLengths: number;
}

const epochMs = (fitSeconds: number): number => (fitSeconds + fitEpochSeconds) * 1000;

function deviceName(manufacturer: number | null, product: number | null, name: string | null): string | null {
  if (name !== null) return name;
  if (manufacturer === null) return null;
  const maker = manufacturers[manufacturer] ?? `FIT ${manufacturer}`;
  if (product === null) return maker;
  return `${maker} ${(manufacturer === garmin ? garminProducts[product] : undefined) ?? product}`;
}

function position(fields: FieldValues): { readonly latitudeE7: number | null; readonly longitudeE7: number | null } {
  const latitude = fields.number(0);
  const longitude = fields.number(1);
  if (latitude === null || longitude === null) return { latitudeE7: null, longitudeE7: null };
  if (Math.abs(latitude) > maxSemicircleLatitude) throw new ImportError("invalid_coordinates", `latitude ${latitude * semicircleDegrees} is off the globe`);
  return { latitudeE7: Math.round(latitude * semicircleDegrees * 1e7), longitudeE7: Math.round(longitude * semicircleDegrees * 1e7) };
}

function collect(file: FitFile, global: number, fields: FieldValues, timestamp: number | null): void {
  switch (global) {
    case message.fileId: {
      file.fileType ??= fields.number(0);
      const manufacturer = fields.number(1);
      const product = fields.number(2);
      const serial = fields.number(3);
      const created = fields.number(4);
      file.identity ??= serial === null || created === null ? null : `fit:${manufacturer ?? 0}:${product ?? 0}:${serial}:${created}`;
      file.device ??= deviceName(manufacturer, product, fields.string(8));
      return;
    }
    case message.deviceInfo:
      if (fields.number(0) === 0) file.creator ??= deviceName(fields.number(2), fields.number(4), fields.string(27));
      return;
    case message.sport:
      file.sport ??= fields.number(0);
      file.subSport ??= fields.number(1);
      return;
    case message.record: {
      if (timestamp === null) return;
      const altitude = fields.number(78) ?? fields.number(2);
      const cadence = fields.number(4);
      const fraction = fields.number(53);
      file.points.push({
        time: epochMs(timestamp),
        ...position(fields),
        altitudeMm: altitude === null ? null : Math.round(altitude * 200 - 500_000),
        heartRate: fields.number(3),
        cadence: cadence === null ? null : cadence + (fraction ?? 0) / 128,
        speedMmS: fields.number(73) ?? fields.number(6),
        courseCentiDeg: null,
        horizontalAccuracyDm: null,
        verticalAccuracyDm: null,
        speedAccuracyCmS: null,
        pressurePa: null,
      });
      return;
    }
    case message.event: {
      if (timestamp === null || fields.number(0) !== eventTimer) return;
      const type = fields.number(1);
      if (type === eventType.start) file.timer.push({ time: epochMs(timestamp), kind: "start" });
      if (type === eventType.stop || type === eventType.stopAll || type === eventType.stopDisable || type === eventType.stopDisableAll) file.timer.push({ time: epochMs(timestamp), kind: "stop" });
      return;
    }
    case message.lap: {
      const start = fields.number(2);
      if (start !== null) file.lapStarts.push(epochMs(start));
      return;
    }
    case message.length:
      if (fields.number(12) === lengthTypeActive) file.activeLengths += 1;
      return;
    case message.session: {
      const start = fields.number(2);
      const poolLength = fields.number(44);
      const distance = fields.number(9);
      file.sessions.push({
        startTime: start === null ? null : epochMs(start),
        sport: fields.number(5),
        subSport: fields.number(6),
        totals: {
          elapsedMs: fields.number(7),
          timerMs: fields.number(8),
          distanceMm: distance === null ? null : distance * 10,
          energyKcal: fields.number(11),
          heartRateAvg: fields.number(16),
          heartRateMax: fields.number(17),
        },
        poolLengthMeters: poolLength === null ? null : ((poolLength / 100) * (fields.number(46) === displayMeasureStatute ? yardMeters : 1)),
        activeLengths: fields.number(47),
      });
      return;
    }
    default:
      return;
  }
}

/** Decodes the data records of one FIT file of a possibly chained file, from its header at `start`; returns the next file's offset. */
function decodeFile(bytes: Uint8Array, view: DataView, start: number, file: FitFile): number {
  if (bytes.length - start < 12) throw new ImportError("truncated", "the FIT header is incomplete");
  const headerSize = bytes[start] ?? 0;
  if (headerSize < 12 || String.fromCharCode(...bytes.subarray(start + 8, start + 12)) !== ".FIT") throw new ImportError("unsupported_format", "not a FIT file");
  const dataSize = view.getUint32(start + 4, true);
  const dataStart = start + headerSize;
  const dataEnd = dataStart + dataSize;
  if (dataEnd + 2 > bytes.length) throw new ImportError("truncated", `the FIT file declares ${dataSize} bytes of data, ${Math.max(bytes.length - dataStart - 2, 0)} are present`);
  if (headerSize >= 14) {
    const headerCrc = view.getUint16(start + 12, true);
    if (headerCrc !== 0 && headerCrc !== fitCrc(bytes, start, start + 12)) throw new ImportError("checksum", "the FIT header CRC does not match");
  }
  if (view.getUint16(dataEnd, true) !== fitCrc(bytes, start, dataEnd)) throw new ImportError("checksum", "the FIT file CRC does not match");
  const definitions = new Map<number, MessageDefinition>();
  let timestamp: number | null = null;
  let offset = dataStart;
  const need = (length: number): void => {
    if (offset + length > dataEnd) throw new ImportError("malformed", `a FIT record overruns the data at byte ${offset}`);
  };
  while (offset < dataEnd) {
    const header = bytes[offset] ?? 0;
    offset += 1;
    if ((header & 0x80) === 0 && (header & 0x40) !== 0) {
      need(5);
      const littleEndian = bytes[offset + 1] === 0;
      const global = view.getUint16(offset + 2, littleEndian);
      const count = bytes[offset + 4] ?? 0;
      offset += 5;
      need(count * 3);
      const fields: FieldDefinition[] = [];
      let size = 0;
      for (let index = 0; index < count; index += 1) {
        const fieldSize = bytes[offset + index * 3 + 1] ?? 0;
        fields.push({ number: bytes[offset + index * 3] ?? 0, offset: size, size: fieldSize, baseType: (bytes[offset + index * 3 + 2] ?? 0) & 0x1f });
        size += fieldSize;
      }
      offset += count * 3;
      if ((header & 0x20) !== 0) {
        need(1);
        const developerCount = bytes[offset] ?? 0;
        offset += 1;
        need(developerCount * 3);
        for (let index = 0; index < developerCount; index += 1) size += bytes[offset + index * 3 + 1] ?? 0;
        offset += developerCount * 3;
      }
      definitions.set(header & 0x0f, { global, littleEndian, fields, size });
      continue;
    }
    const compressed = (header & 0x80) !== 0;
    const local = compressed ? (header >> 5) & 0x03 : header & 0x0f;
    const definition = definitions.get(local);
    if (definition === undefined) throw new ImportError("malformed", `a FIT data message at byte ${offset - 1} has no definition`);
    need(definition.size);
    const fields = new FieldValues(view, offset, definition);
    let time = fields.number(timestampField);
    if (compressed) {
      if (timestamp === null) throw new ImportError("malformed", "a compressed timestamp comes before any timestamp");
      const delta = header & 0x1f;
      time = timestamp - (timestamp % 0x20) + delta + (delta >= timestamp % 0x20 ? 0 : 0x20);
    }
    timestamp = time ?? timestamp;
    collect(file, definition.global, fields, time);
    offset += definition.size;
  }
  return dataEnd + 2;
}

function poolSwim(session: FitSession | undefined, activeLengths: number): PoolSwim | null {
  if (session === undefined || session.poolLengthMeters === null) return null;
  const lengths = session.activeLengths ?? activeLengths;
  if (lengths <= 0) return null;
  const distanceMeters = session.totals.distanceMm === null ? lengths * session.poolLengthMeters : session.totals.distanceMm / 1000;
  return { poolLengthMeters: Math.round(session.poolLengthMeters), lengths, distanceMeters: Math.round(distanceMeters) };
}

/**
 * Reads a FIT activity file (`IO-050`): header and file CRC, chained files, developer fields (skipped), compressed timestamps,
 * either endianness. Takes positions, altitude (enhanced when present), heart rate, cadence, timer events, laps, the first
 * session's sport and totals, and the pool lengths of a lap swim. Refuses any other FIT file type.
 */
export function readFit(bytes: Uint8Array): ImportedActivity {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const file: FitFile = { fileType: null, identity: null, device: null, creator: null, sport: null, subSport: null, sessions: [], points: [], timer: [], lapStarts: [], activeLengths: 0 };
  let offset = 0;
  while (offset < bytes.length) offset = decodeFile(bytes, view, offset, file);
  if (file.fileType !== fileTypeActivity) throw new ImportError("not_an_activity", file.fileType === null ? "the FIT file has no file_id" : `the FIT file type is ${file.fileType}, not an activity`);
  const session = file.sessions[0];
  const sport = session?.sport ?? file.sport;
  const subSport = session?.subSport ?? file.subSport;
  const positioned = file.points.some((point) => point.latitudeE7 !== null);
  const pool = sport === fitSport.swimming && !positioned ? poolSwim(session, file.activeLengths) : null;
  return assembleActivity({
    format: "fit",
    externalId: file.identity ?? contentId(bytes),
    device: file.device ?? file.creator,
    name: null,
    sport: sport === null ? null : sportOfFit(sport, subSport, positioned),
    startTime: session?.startTime ?? null,
    points: file.points,
    segmentStarts: [],
    timer: file.timer,
    lapStarts: file.lapStarts,
    totals: session?.totals ?? null,
    pool,
  });
}
