/** Encoded polyline algorithm format (Google), at 5 decimals (stored previews) or 6 decimals. */
export type PolylinePrecision = 5 | 6;

/** Coordinates in 1e-7 degrees; `FixColumns` satisfies it. */
export interface CoordinatePath {
  readonly length: number;
  readonly latitudeE7: ArrayLike<number>;
  readonly longitudeE7: ArrayLike<number>;
}

export interface DecodedPath {
  readonly length: number;
  readonly latitudeE7: Int32Array;
  readonly longitudeE7: Int32Array;
}

export class PolylineDecodeError extends Error {
  constructor(readonly offset: number) {
    super(`Invalid polyline at character ${offset}`);
  }
}

const firstCharacter = 63;
const lastCharacter = 126;
const continuationBit = 0x20;
/** A coordinate delta takes at most 30 bits at 6 decimals, so 6 characters of 5 bits. */
const maxCharactersPerValue = 6;

const divisor = (precision: PolylinePrecision): number => 10 ** (7 - precision);

/** Rounds half away from zero, so a path and its mirror image encode symmetrically. */
function quantize(valueE7: number, step: number): number {
  const rounded = Math.round(Math.abs(valueE7) / step);
  return valueE7 < 0 ? -rounded : rounded;
}

function pushValue(characters: number[], value: number): void {
  let rest = value < 0 ? ~(value << 1) : value << 1;
  while (rest >= continuationBit) {
    characters.push((continuationBit | (rest & 0x1f)) + firstCharacter);
    rest >>>= 5;
  }
  characters.push(rest + firstCharacter);
}

export function encodePolyline(path: CoordinatePath, precision: PolylinePrecision): string {
  const step = divisor(precision);
  const characters: number[] = [];
  let previousLatitude = 0;
  let previousLongitude = 0;
  for (let index = 0; index < path.length; index += 1) {
    const latitude = quantize(path.latitudeE7[index] ?? 0, step);
    const longitude = quantize(path.longitudeE7[index] ?? 0, step);
    pushValue(characters, latitude - previousLatitude);
    pushValue(characters, longitude - previousLongitude);
    previousLatitude = latitude;
    previousLongitude = longitude;
  }
  const parts: string[] = [];
  for (let start = 0; start < characters.length; start += 8192) parts.push(String.fromCharCode(...characters.slice(start, start + 8192)));
  return parts.join("");
}

/** Decodes into 1e-7 degree columns; rejects foreign characters, unpaired or unterminated values and out-of-bounds coordinates. */
export function decodePolyline(text: string, precision: PolylinePrecision): DecodedPath {
  const step = divisor(precision);
  const maxLatitude = 90 * 10 ** precision;
  const maxLongitude = 180 * 10 ** precision;
  const values: number[] = [];
  let index = 0;
  while (index < text.length) {
    const start = index;
    let result = 0;
    let shift = 0;
    let chunk: number;
    do {
      if (index >= text.length || index - start >= maxCharactersPerValue) throw new PolylineDecodeError(start);
      chunk = text.charCodeAt(index) - firstCharacter;
      if (chunk < 0 || chunk > lastCharacter - firstCharacter) throw new PolylineDecodeError(index);
      result |= (chunk & 0x1f) << shift;
      shift += 5;
      index += 1;
    } while (chunk >= continuationBit);
    values.push(result & 1 ? ~(result >> 1) : result >> 1);
  }
  if (values.length % 2 !== 0) throw new PolylineDecodeError(text.length);
  const length = values.length / 2;
  const latitudeE7 = new Int32Array(length);
  const longitudeE7 = new Int32Array(length);
  let latitude = 0;
  let longitude = 0;
  for (let point = 0; point < length; point += 1) {
    latitude += values[point * 2] ?? 0;
    longitude += values[point * 2 + 1] ?? 0;
    if (Math.abs(latitude) > maxLatitude || Math.abs(longitude) > maxLongitude) throw new PolylineDecodeError(text.length);
    latitudeE7[point] = latitude * step;
    longitudeE7[point] = longitude * step;
  }
  return { length, latitudeE7, longitudeE7 };
}
