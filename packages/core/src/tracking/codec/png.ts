import { unzlibSync } from "fflate";
import { crc32 } from "./crc32.ts";

/** An 8-bit truecolor image, rows top to bottom, `channels` bytes per pixel. */
export interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly pixels: Uint8Array;
}

export class PngDecodeError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid PNG: ${reason}`);
  }
}

const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const chunkOverhead = 12;
const rgbColorType = 2;
const rgbaColorType = 6;

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** Reverses the per-row filters of the inflated scanlines into `pixels`. */
function unfilter(scanlines: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  if (scanlines.length !== height * (stride + 1)) throw new PngDecodeError("image data does not match its size");
  const pixels = new Uint8Array(height * stride);
  for (let row = 0; row < height; row += 1) {
    const filter = scanlines[row * (stride + 1)] ?? 0;
    const source = row * (stride + 1) + 1;
    const target = row * stride;
    const above = target - stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = scanlines[source + column] ?? 0;
      const left = column >= channels ? (pixels[target + column - channels] ?? 0) : 0;
      const up = row > 0 ? (pixels[above + column] ?? 0) : 0;
      const upLeft = row > 0 && column >= channels ? (pixels[above + column - channels] ?? 0) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4:
          value = raw + paeth(left, up, upLeft);
          break;
        default:
          throw new PngDecodeError(`row ${row} has filter ${filter}`);
      }
      pixels[target + column] = value & 0xff;
    }
  }
  return pixels;
}

/** Decodes the 8-bit RGB or RGBA, non-interlaced PNG of a raster tile, checking every chunk CRC. */
export function decodePng(bytes: Uint8Array): PngImage {
  if (bytes.length < signature.length + chunkOverhead) throw new PngDecodeError("file too short");
  for (const [index, byte] of signature.entries()) if (bytes[index] !== byte) throw new PngDecodeError("not a PNG file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = signature.length;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 | null = null;
  const data: Uint8Array[] = [];
  let dataLength = 0;
  let ended = false;
  while (!ended) {
    if (offset + chunkOverhead > bytes.length) throw new PngDecodeError("chunk truncated");
    const length = view.getUint32(offset);
    const end = offset + 8 + length;
    if (end + 4 > bytes.length) throw new PngDecodeError("chunk truncated");
    if (crc32(bytes, offset + 4, end) !== view.getUint32(end)) throw new PngDecodeError("chunk CRC mismatch");
    const type = String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0);
    const body = offset + 8;
    switch (type) {
      case "IHDR": {
        width = view.getUint32(body);
        height = view.getUint32(body + 4);
        const depth = bytes[body + 8];
        const colorType = bytes[body + 9];
        const interlace = bytes[body + 12];
        if (depth !== 8 || interlace !== 0 || (colorType !== rgbColorType && colorType !== rgbaColorType)) throw new PngDecodeError("only 8-bit RGB or RGBA without interlace is read");
        channels = colorType === rgbColorType ? 3 : 4;
        break;
      }
      case "IDAT":
        data.push(bytes.subarray(body, end));
        dataLength += length;
        break;
      case "IEND":
        ended = true;
        break;
      default:
        break;
    }
    offset = end + 4;
  }
  if (channels === null || width === 0 || height === 0 || dataLength === 0) throw new PngDecodeError("missing header or image data");
  const compressed = new Uint8Array(dataLength);
  let position = 0;
  for (const part of data) {
    compressed.set(part, position);
    position += part.length;
  }
  let scanlines: Uint8Array;
  try {
    scanlines = unzlibSync(compressed);
  } catch (error) {
    if (error instanceof Error && "code" in error) throw new PngDecodeError(`image data does not inflate: ${error.message}`);
    throw error;
  }
  return { width, height, channels, pixels: unfilter(scanlines, width, height, channels) };
}
