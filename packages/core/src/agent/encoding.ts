const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const lookup = new Map<string, number>(Array.from(alphabet, (character, index) => [character, index]));

export class Base64Error extends Error {
  constructor() {
    super("Invalid base64 payload");
  }
}

export class Utf8Error extends Error {
  constructor() {
    super("Invalid UTF-8 payload");
  }
}

function continuation(bytes: Uint8Array, index: number): number {
  const byte = bytes[index];
  if (byte === undefined || (byte & 0xc0) !== 0x80) throw new Utf8Error();
  return byte & 0x3f;
}

/** Strict UTF-8 decoding without TextDecoder, which Hermes does not guarantee. */
export function fromUtf8(bytes: Uint8Array): string {
  const codePoints: number[] = [];
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index] ?? 0;
    let codePoint: number;
    let length: number;
    if (lead < 0x80) {
      codePoint = lead;
      length = 1;
    } else if (lead >= 0xc2 && lead < 0xe0) {
      codePoint = ((lead & 0x1f) << 6) | continuation(bytes, index + 1);
      length = 2;
    } else if (lead >= 0xe0 && lead < 0xf0) {
      codePoint = ((lead & 0x0f) << 12) | (continuation(bytes, index + 1) << 6) | continuation(bytes, index + 2);
      if (codePoint < 0x800 || (codePoint >= 0xd800 && codePoint < 0xe000)) throw new Utf8Error();
      length = 3;
    } else if (lead >= 0xf0 && lead < 0xf5) {
      codePoint = ((lead & 0x07) << 18) | (continuation(bytes, index + 1) << 12) | (continuation(bytes, index + 2) << 6) | continuation(bytes, index + 3);
      if (codePoint < 0x10000 || codePoint > 0x10ffff) throw new Utf8Error();
      length = 4;
    } else {
      throw new Utf8Error();
    }
    codePoints.push(codePoint);
    index += length;
  }
  let text = "";
  for (let start = 0; start < codePoints.length; start += 4096) text += String.fromCodePoint(...codePoints.slice(start, start + 4096));
  return text;
}

export function toBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const chunk = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += alphabet.charAt((chunk >> 18) & 63) + alphabet.charAt((chunk >> 12) & 63);
    output += second === undefined ? "=" : alphabet.charAt((chunk >> 6) & 63);
    output += third === undefined ? "=" : alphabet.charAt(chunk & 63);
  }
  return output;
}

export function fromBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new Base64Error();
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let cursor = 0;
  for (let index = 0; index < text.length; index += 4) {
    let chunk = 0;
    for (let offset = 0; offset < 4; offset += 1) {
      const character = text.charAt(index + offset);
      const isPadding = character === "=" && index + offset >= text.length - padding;
      const value = isPadding ? 0 : lookup.get(character);
      if (value === undefined) throw new Base64Error();
      chunk = (chunk << 6) | value;
    }
    for (let shift = 16; shift >= 0 && cursor < bytes.length; shift -= 8) {
      bytes[cursor] = (chunk >> shift) & 255;
      cursor += 1;
    }
  }
  return bytes;
}
