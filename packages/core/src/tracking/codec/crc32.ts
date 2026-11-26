const table = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  table[index] = value;
}

/** CRC-32 (IEEE 802.3, the one of zlib, `java.util.zip.CRC32` and gzip) of `bytes[start, end)`. */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  return crc32Update(0, bytes, start, end);
}

/** The CRC-32 of the bytes summed into `crc` followed by `bytes[start, end)`, to check data read in chunks. */
export function crc32Update(crc: number, bytes: Uint8Array, start = 0, end = bytes.length): number {
  let value = (crc ^ 0xffffffff) >>> 0;
  for (let index = start; index < end; index += 1) value = (table[(value ^ (bytes[index] ?? 0)) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
