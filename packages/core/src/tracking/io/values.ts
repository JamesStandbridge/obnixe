import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ImportError } from "./errors.ts";

const isoTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/;
const decimal = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const maxLatitudeE7 = 900_000_000;
const maxLongitudeE7 = 1_800_000_000;

/** ISO 8601 date and time in milliseconds since the epoch; without an offset, UTC as GPX and TCX require. */
export function parseTime(text: string): number {
  const match = isoTime.exec(text.trim());
  if (match === null) throw new ImportError("invalid_value", `"${text}" is not a date and time`);
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const milliseconds = fraction === undefined ? 0 : Math.round(Number(`0.${fraction}`) * 1000);
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds);
  let offsetMinutes = 0;
  if (zone !== undefined && zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || "0"));
  }
  const date = new Date(utc);
  if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) throw new ImportError("invalid_value", `"${text}" is not a valid date`);
  return utc - offsetMinutes * 60_000;
}

export function parseDecimal(text: string, what: string): number {
  const trimmed = text.trim();
  if (!decimal.test(trimmed)) throw new ImportError("invalid_value", `${what} "${text}" is not a number`);
  return Number(trimmed);
}

export interface PositionE7 {
  readonly latitudeE7: number;
  readonly longitudeE7: number;
}

/** Degrees to the 1e-7 degree integers of the samples, refusing positions off the globe. */
export function positionE7(latitude: number, longitude: number): PositionE7 {
  const latitudeE7 = Math.round(latitude * 1e7);
  const longitudeE7 = Math.round(longitude * 1e7);
  if (Math.abs(latitudeE7) > maxLatitudeE7 || Math.abs(longitudeE7) > maxLongitudeE7) throw new ImportError("invalid_coordinates", `${latitude}, ${longitude} is off the globe`);
  return { latitudeE7, longitudeE7 };
}

/** Identity of a file without a device identity: the same content imported twice is the same activity. */
export function contentId(bytes: Uint8Array): string {
  return `sha256:${bytesToHex(sha256(bytes))}`;
}
