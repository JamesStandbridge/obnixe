export class InvalidUtf8Error extends Error {
  constructor(readonly offset: number) {
    super(`Invalid UTF-8 sequence at byte ${offset}`);
  }
}

export function encodeUtf8(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 3);
  let length = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes[length++] = code;
    } else if (code < 0x800) {
      bytes[length++] = 0xc0 | (code >> 6);
      bytes[length++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      bytes[length++] = 0xe0 | (code >> 12);
      bytes[length++] = 0x80 | ((code >> 6) & 0x3f);
      bytes[length++] = 0x80 | (code & 0x3f);
    } else {
      bytes[length++] = 0xf0 | (code >> 18);
      bytes[length++] = 0x80 | ((code >> 12) & 0x3f);
      bytes[length++] = 0x80 | ((code >> 6) & 0x3f);
      bytes[length++] = 0x80 | (code & 0x3f);
    }
  }
  return bytes.slice(0, length);
}

export function decodeUtf8(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk: number[] = [];
  let index = 0;
  const continuation = (at: number): number => {
    const byte = bytes[at];
    if (byte === undefined || (byte & 0xc0) !== 0x80) throw new InvalidUtf8Error(at);
    return byte & 0x3f;
  };
  while (index < bytes.length) {
    const lead = bytes[index] ?? 0;
    let code: number;
    if (lead < 0x80) {
      code = lead;
      index += 1;
    } else if ((lead & 0xe0) === 0xc0) {
      code = ((lead & 0x1f) << 6) | continuation(index + 1);
      if (code < 0x80) throw new InvalidUtf8Error(index);
      index += 2;
    } else if ((lead & 0xf0) === 0xe0) {
      code = ((lead & 0x0f) << 12) | (continuation(index + 1) << 6) | continuation(index + 2);
      if (code < 0x800 || (code >= 0xd800 && code <= 0xdfff)) throw new InvalidUtf8Error(index);
      index += 3;
    } else if ((lead & 0xf8) === 0xf0) {
      code = ((lead & 0x07) << 18) | (continuation(index + 1) << 12) | (continuation(index + 2) << 6) | continuation(index + 3);
      if (code < 0x10000 || code > 0x10ffff) throw new InvalidUtf8Error(index);
      index += 4;
    } else {
      throw new InvalidUtf8Error(index);
    }
    chunk.push(code);
    if (chunk.length >= 8192) {
      parts.push(String.fromCodePoint(...chunk));
      chunk = [];
    }
  }
  if (chunk.length > 0) parts.push(String.fromCodePoint(...chunk));
  return parts.join("");
}
