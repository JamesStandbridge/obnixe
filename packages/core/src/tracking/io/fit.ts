import type { LapTrigger } from "@obnixe/schema";
import { decodeUtf8, encodeUtf8, InvalidUtf8Error } from "../../data/utf8.ts";
import { assembleActivity } from "./activity.ts";
import type { ExportPoint, FilePoint, FileTimerEvent, FileTotals, ImportedActivity, PoolSwim } from "./activity.ts";
import { ImportError } from "./errors.ts";
import { fitSport, sportOfFit } from "./sports.ts";
import type { FitSportPair } from "./sports.ts";
import { contentId } from "./values.ts";

/** Seconds from the Unix epoch to the FIT epoch, 1989-12-31T00:00:00Z. */
const fitEpochSeconds = 631_065_600;
const semicircleDegrees = 180 / 2 ** 31;
const maxSemicircleLatitude = 2 ** 30;

const message = { fileId: 0, sport: 12, session: 18, lap: 19, record: 20, event: 21, deviceInfo: 23, activity: 34, length: 101, fieldDescription: 206, developerDataId: 207 } as const;
const fileTypeActivity = 4;
const eventTimer = 0;
const eventKind = { session: 8, lap: 9, activity: 26 } as const;
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
const byteType = 13;

/** `developer_data_id.application_id` of the Obnixe record fields, which other software ignores. */
const obnixeApplicationId = Uint8Array.from([0x6f, 0x62, 0x6e, 0x69, 0x78, 0x65, 0x4a, 0x2e, 0x9c, 0x41, 0x0d, 0x5b, 0x83, 0xe2, 0x17, 0xa6]);
/**
 * Developer field numbers of the fix data that standard `record` fields cannot carry and the processing needs to give the
 * same results when the file is imported again (`IO-001`), all uint16.
 */
const obnixeField = { course: 0, horizontalAccuracy: 1, verticalAccuracy: 2, speedAccuracy: 3 } as const;

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

interface DeveloperFieldDefinition {
  readonly number: number;
  readonly offset: number;
  readonly size: number;
  readonly developerIndex: number;
}

interface MessageDefinition {
  readonly global: number;
  readonly littleEndian: boolean;
  readonly fields: readonly FieldDefinition[];
  readonly developerFields: readonly DeveloperFieldDefinition[];
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

  bytes(field: number): Uint8Array | null {
    const definition = this.definition.fields.find((candidate) => candidate.number === field && candidate.baseType === byteType);
    return definition === undefined ? null : new Uint8Array(this.view.buffer, this.view.byteOffset + this.start + definition.offset, definition.size);
  }

  /** A uint16 developer field. */
  developer(developerIndex: number, field: number): number | null {
    const definition = this.definition.developerFields.find((candidate) => candidate.developerIndex === developerIndex && candidate.number === field);
    if (definition?.size !== 2) return null;
    const value = this.view.getUint16(this.start + definition.offset, this.definition.littleEndian);
    return value === 0xffff ? null : value;
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
  obnixeIndex: number | null;
}

const epochMs = (fitSeconds: number): number => (fitSeconds + fitEpochSeconds) * 1000;
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index]);

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
    case message.developerDataId: {
      const application = fields.bytes(1);
      if (application !== null && sameBytes(application, obnixeApplicationId)) file.obnixeIndex = fields.number(3) ?? 0;
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
      const accuracy = fields.number(31);
      const obnixe = (field: number): number | null => (file.obnixeIndex === null ? null : fields.developer(file.obnixeIndex, field));
      file.points.push({
        time: epochMs(timestamp),
        ...position(fields),
        altitudeMm: altitude === null ? null : Math.round(altitude * 200 - 500_000),
        heartRate: fields.number(3),
        cadence: cadence === null ? null : cadence + (fraction ?? 0) / 128,
        speedMmS: fields.number(73) ?? fields.number(6),
        courseCentiDeg: obnixe(obnixeField.course),
        horizontalAccuracyDm: obnixe(obnixeField.horizontalAccuracy) ?? (accuracy === null || accuracy === 0 ? null : accuracy * 10),
        verticalAccuracyDm: obnixe(obnixeField.verticalAccuracy),
        speedAccuracyCmS: obnixe(obnixeField.speedAccuracy),
        pressurePa: fields.number(91),
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
      const developerFields: DeveloperFieldDefinition[] = [];
      if ((header & 0x20) !== 0) {
        need(1);
        const developerCount = bytes[offset] ?? 0;
        offset += 1;
        need(developerCount * 3);
        for (let index = 0; index < developerCount; index += 1) {
          const fieldSize = bytes[offset + index * 3 + 1] ?? 0;
          developerFields.push({ number: bytes[offset + index * 3] ?? 0, offset: size, size: fieldSize, developerIndex: bytes[offset + index * 3 + 2] ?? 0 });
          size += fieldSize;
        }
        offset += developerCount * 3;
      }
      definitions.set(header & 0x0f, { global, littleEndian, fields, developerFields, size });
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
 * Reads a FIT activity file (`IO-050`): header and file CRC, chained files, developer fields (skipped but the Obnixe ones),
 * compressed timestamps, either endianness. Takes positions, altitude (enhanced when present), GPS accuracy, pressure, heart
 * rate, cadence, timer events, laps, the first session's sport and totals, and the pool lengths of a lap swim. Refuses any
 * other FIT file type.
 */
export function readFit(bytes: Uint8Array): ImportedActivity {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const file: FitFile = { fileType: null, identity: null, device: null, creator: null, sport: null, subSport: null, sessions: [], points: [], timer: [], lapStarts: [], activeLengths: 0, obnixeIndex: null };
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

/** A lap or the session of an exported activity, at absolute instants. */
export interface FitStretch {
  readonly startTime: number;
  readonly endTime: number;
  /** Elapsed time outside the manual pauses. */
  readonly timerMs: number;
  readonly distanceMm: number;
  readonly energyKcal: number | null;
  readonly heartRateAvg: number | null;
  readonly heartRateMax: number | null;
}

export interface FitLap extends FitStretch {
  readonly trigger: LapTrigger;
}

export interface FitDocument {
  readonly sport: FitSportPair;
  /** Timer start at the start and at each resume, stop at each pause and at the end. */
  readonly timer: readonly FileTimerEvent[];
  readonly points: readonly ExportPoint[];
  readonly laps: readonly FitLap[];
  readonly session: FitStretch;
}

type FitBaseType = "enum" | "uint8" | "sint8" | "uint16" | "sint32" | "uint32" | "string" | "bytes";

/** Base type byte, size, and the valid range `[min, invalid)` of each base type written. */
const encodedTypes: Readonly<Record<FitBaseType, { readonly id: number; readonly size: number; readonly min: number; readonly invalid: number }>> = {
  enum: { id: 0x00, size: 1, min: 0, invalid: 0xff },
  uint8: { id: 0x02, size: 1, min: 0, invalid: 0xff },
  sint8: { id: 0x01, size: 1, min: -0x7f, invalid: 0x7f },
  uint16: { id: 0x84, size: 2, min: 0, invalid: 0xffff },
  sint32: { id: 0x85, size: 4, min: -0x7fffffff, invalid: 0x7fffffff },
  uint32: { id: 0x86, size: 4, min: 0, invalid: 0xffffffff },
  string: { id: 0x07, size: 16, min: 0, invalid: 0 },
  bytes: { id: 0x0d, size: 16, min: 0, invalid: 0xff },
};

interface FitFieldLayout {
  readonly number: number;
  readonly type: FitBaseType;
}

interface FitLayout {
  readonly local: number;
  readonly global: number;
  readonly fields: readonly FitFieldLayout[];
  /** Obnixe developer fields, written after `fields`. */
  readonly developer?: readonly FitFieldLayout[];
}

type FitValue = number | string | Uint8Array | null;

const field = (number: number, type: FitBaseType): FitFieldLayout => ({ number, type });
const timestamp = field(timestampField, "uint32");
const messageIndex = field(254, "uint16");
const layouts = {
  fileId: { local: 0, global: message.fileId, fields: [field(0, "enum"), field(1, "uint16"), field(2, "uint16"), field(4, "uint32"), field(8, "string")] },
  event: { local: 1, global: message.event, fields: [timestamp, field(0, "enum"), field(1, "enum"), field(4, "uint8")] },
  record: {
    local: 2,
    global: message.record,
    fields: [timestamp, field(0, "sint32"), field(1, "sint32"), field(5, "uint32"), field(78, "uint32"), field(73, "uint32"), field(3, "uint8"), field(4, "uint8"), field(31, "uint8"), field(91, "uint32")],
    developer: [field(obnixeField.course, "uint16"), field(obnixeField.horizontalAccuracy, "uint16"), field(obnixeField.verticalAccuracy, "uint16"), field(obnixeField.speedAccuracy, "uint16")],
  },
  lap: {
    local: 3,
    global: message.lap,
    fields: [timestamp, messageIndex, field(0, "enum"), field(1, "enum"), field(2, "uint32"), field(7, "uint32"), field(8, "uint32"), field(9, "uint32"), field(11, "uint16"), field(15, "uint8"), field(16, "uint8"), field(24, "enum"), field(25, "enum")],
  },
  session: {
    local: 4,
    global: message.session,
    fields: [timestamp, messageIndex, field(0, "enum"), field(1, "enum"), field(2, "uint32"), field(5, "enum"), field(6, "enum"), field(7, "uint32"), field(8, "uint32"), field(9, "uint32"), field(11, "uint16"), field(16, "uint8"), field(17, "uint8"), field(25, "uint16"), field(26, "uint16"), field(28, "enum")],
  },
  activity: { local: 5, global: message.activity, fields: [timestamp, field(0, "uint32"), field(1, "uint16"), field(2, "enum"), field(3, "enum"), field(4, "enum")] },
  developerDataId: { local: 6, global: message.developerDataId, fields: [field(1, "bytes"), field(3, "uint8")] },
  fieldDescription: { local: 7, global: message.fieldDescription, fields: [field(0, "uint8"), field(1, "uint8"), field(2, "uint8"), field(3, "string"), field(6, "uint8"), field(7, "sint8"), field(8, "string"), field(14, "uint16")] },
} as const satisfies Record<string, FitLayout>;

interface ObnixeFieldDescription {
  readonly number: number;
  readonly name: string;
  readonly scale: number;
  readonly units: string;
}

const obnixeFieldDescriptions: readonly ObnixeFieldDescription[] = [
  { number: obnixeField.course, name: "obnixe_course", scale: 100, units: "degrees" },
  { number: obnixeField.horizontalAccuracy, name: "obnixe_hacc", scale: 10, units: "m" },
  { number: obnixeField.verticalAccuracy, name: "obnixe_vacc", scale: 10, units: "m" },
  { number: obnixeField.speedAccuracy, name: "obnixe_sacc", scale: 100, units: "m/s" },
];
const obnixeDeveloperIndex = 0;

const fitHeaderSize = 14;
const fitProtocolVersion = 0x20;
const fitProfileVersion = 21_222;
const developmentManufacturer = 255;
const productName = "Obnixe";
const activityTypeManual = 0;
const sessionTriggerActivityEnd = 0;
const maxFitByte = 254;

/** Little-endian FIT data records, each local message type defined before its first message. */
class FitEncoder {
  private bytes = new Uint8Array(1 << 16);
  private view = new DataView(this.bytes.buffer);
  private length = fitHeaderSize;
  private readonly defined = new Set<number>();

  write(layout: FitLayout, values: readonly FitValue[]): void {
    if (!this.defined.has(layout.local)) this.define(layout);
    this.byte(layout.local);
    [...layout.fields, ...(layout.developer ?? [])].forEach((fieldLayout, index) => this.value(fieldLayout.type, values[index] ?? null));
  }

  finish(): Uint8Array {
    const dataSize = this.length - fitHeaderSize;
    this.view.setUint8(0, fitHeaderSize);
    this.view.setUint8(1, fitProtocolVersion);
    this.view.setUint16(2, fitProfileVersion, true);
    this.view.setUint32(4, dataSize, true);
    this.bytes.set([0x2e, 0x46, 0x49, 0x54], 8);
    this.view.setUint16(12, fitCrc(this.bytes, 0, 12), true);
    const crc = fitCrc(this.bytes, 0, this.length);
    this.reserve(2);
    this.view.setUint16(this.length, crc, true);
    this.length += 2;
    return this.bytes.slice(0, this.length);
  }

  private define(layout: FitLayout): void {
    this.defined.add(layout.local);
    const developer = layout.developer ?? [];
    this.byte(0x40 | (developer.length > 0 ? 0x20 : 0) | layout.local);
    this.byte(0);
    this.byte(0);
    this.reserve(2);
    this.view.setUint16(this.length, layout.global, true);
    this.length += 2;
    this.byte(layout.fields.length);
    for (const fieldLayout of layout.fields) {
      const type = encodedTypes[fieldLayout.type];
      this.byte(fieldLayout.number);
      this.byte(type.size);
      this.byte(type.id);
    }
    if (developer.length === 0) return;
    this.byte(developer.length);
    for (const fieldLayout of developer) {
      this.byte(fieldLayout.number);
      this.byte(encodedTypes[fieldLayout.type].size);
      this.byte(obnixeDeveloperIndex);
    }
  }

  private value(typeName: FitBaseType, value: FitValue): void {
    const type = encodedTypes[typeName];
    this.reserve(type.size);
    if (typeName === "string" || typeName === "bytes") {
      const content = typeof value === "string" ? encodeUtf8(value).subarray(0, type.size - 1) : value instanceof Uint8Array ? value.subarray(0, type.size) : new Uint8Array();
      this.bytes.fill(typeName === "string" ? 0 : type.invalid, this.length, this.length + type.size);
      this.bytes.set(content, this.length);
      this.length += type.size;
      return;
    }
    const rounded = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
    const encoded = rounded !== null && rounded >= type.min && rounded < type.invalid ? rounded : type.invalid;
    switch (typeName) {
      case "enum":
      case "uint8":
        this.view.setUint8(this.length, encoded);
        break;
      case "sint8":
        this.view.setInt8(this.length, encoded);
        break;
      case "uint16":
        this.view.setUint16(this.length, encoded, true);
        break;
      case "sint32":
        this.view.setInt32(this.length, encoded, true);
        break;
      case "uint32":
        this.view.setUint32(this.length, encoded, true);
        break;
      default: {
        const unhandled: never = typeName;
        throw new Error(`No encoding for ${String(unhandled)}`);
      }
    }
    this.length += type.size;
  }

  private byte(value: number): void {
    this.reserve(1);
    this.view.setUint8(this.length, value);
    this.length += 1;
  }

  private reserve(size: number): void {
    if (this.length + size <= this.bytes.length) return;
    const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.length + size));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }
}

/** FIT times are whole seconds since the FIT epoch. */
const fitTime = (epochMs: number): number => Math.round(epochMs / 1000) - fitEpochSeconds;
const semicircles = (e7: number): number => Math.round((e7 / 1e7 / 180) * 2 ** 31);
const fitByte = (value: number | null): number | null => (value === null ? null : Math.min(value, maxFitByte));

function fitLapTrigger(trigger: LapTrigger): number {
  switch (trigger) {
    case "manual":
    case "import":
      return 0;
    case "duration":
      return 1;
    case "distance":
      return 2;
    default: {
      const unhandled: never = trigger;
      throw new Error(`No FIT lap trigger for ${String(unhandled)}`);
    }
  }
}

function recordValues(point: ExportPoint, second: number): readonly FitValue[] {
  return [
    second,
    semicircles(point.latitudeE7),
    semicircles(point.longitudeE7),
    point.distanceMm / 10,
    point.altitudeMm === null ? null : (point.altitudeMm / 1000 + 500) * 5,
    point.speedMmS,
    fitByte(point.heartRate),
    fitByte(point.cadence),
    point.horizontalAccuracyDm === null ? null : fitByte(Math.max(1, Math.round(point.horizontalAccuracyDm / 10))),
    point.pressurePa,
    point.courseCentiDeg,
    point.horizontalAccuracyDm,
    point.verticalAccuracyDm,
    point.speedAccuracyCmS,
  ];
}

function stretchValues(stretch: FitStretch): readonly FitValue[] {
  return [fitTime(stretch.startTime), stretch.endTime - stretch.startTime, stretch.timerMs, stretch.distanceMm / 10, stretch.energyKcal, fitByte(stretch.heartRateAvg), fitByte(stretch.heartRateMax)];
}

/**
 * A FIT activity file (`IO-003`): `file_id` of type activity, timer `event` start and stop around each pause, one `record` per
 * point (semicircles, `enhanced_altitude`, `distance`, `enhanced_speed`, heart rate, cadence, GPS accuracy and pressure, and
 * the course and fix accuracies as Obnixe developer fields), the `lap` messages, one `session` with the annex D sport and sub
 * sport, and `activity`, with valid header and file CRCs. Points falling in the second of the previous one are left out.
 */
export function writeFit(document: FitDocument): Uint8Array {
  const encoder = new FitEncoder();
  const { session, sport } = document;
  encoder.write(layouts.fileId, [fileTypeActivity, developmentManufacturer, 0, fitTime(session.startTime), productName]);
  encoder.write(layouts.developerDataId, [obnixeApplicationId, obnixeDeveloperIndex]);
  for (const description of obnixeFieldDescriptions) {
    encoder.write(layouts.fieldDescription, [obnixeDeveloperIndex, description.number, encodedTypes.uint16.id, description.name, description.scale, 0, description.units, message.record]);
  }
  const events = document.timer.map((event) => ({ second: fitTime(event.time), kind: event.kind }));
  let next = 0;
  const writeEvents = (before: number | null): void => {
    for (; next < events.length; next += 1) {
      const event = events[next];
      if (event === undefined || (before !== null && (event.second > before || (event.second === before && event.kind === "stop")))) return;
      encoder.write(layouts.event, [event.second, eventTimer, event.kind === "start" ? eventType.start : eventType.stopAll, 0]);
    }
  };
  let last = Number.NEGATIVE_INFINITY;
  for (const point of document.points) {
    const second = fitTime(point.time);
    if (second <= last) continue;
    writeEvents(second);
    encoder.write(layouts.record, recordValues(point, second));
    last = second;
  }
  writeEvents(null);
  document.laps.forEach((lap, index) => {
    encoder.write(layouts.lap, [fitTime(lap.endTime), index, eventKind.lap, eventType.stop, ...stretchValues(lap), fitLapTrigger(lap.trigger), sport.sport]);
  });
  const end = fitTime(session.endTime);
  encoder.write(layouts.session, [end, 0, eventKind.session, eventType.stop, fitTime(session.startTime), sport.sport, sport.subSport, ...stretchValues(session).slice(1), 0, document.laps.length, sessionTriggerActivityEnd]);
  encoder.write(layouts.activity, [end, session.timerMs, 1, activityTypeManual, eventKind.activity, eventType.stop]);
  return encoder.finish();
}
