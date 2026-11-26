/** Varints carry at most 35 bits: the zigzag of any difference of two 32-bit integers. */
const maxVarintBytes = 5;
const twoPow32 = 2 ** 32;

export const zigzag = (value: number): number => (value >= 0 ? value * 2 : -value * 2 - 1);

export const unzigzag = (value: number): number => (value % 2 === 0 ? value / 2 : -(value + 1) / 2);

/** Growable little-endian buffer with unsigned LEB128 and zigzag LEB128 varints. */
export class ByteWriter {
  private buffer: Uint8Array;
  private view: DataView;
  private length = 0;

  constructor(capacity = 1024) {
    this.buffer = new Uint8Array(capacity);
    this.view = new DataView(this.buffer.buffer);
  }

  get size(): number {
    return this.length;
  }

  private reserve(bytes: number): void {
    const needed = this.length + bytes;
    if (needed <= this.buffer.length) return;
    let capacity = this.buffer.length * 2;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(value: number): void {
    this.reserve(1);
    this.buffer[this.length] = value;
    this.length += 1;
  }

  u16(value: number): void {
    this.reserve(2);
    this.view.setUint16(this.length, value, true);
    this.length += 2;
  }

  u32(value: number): void {
    this.reserve(4);
    this.view.setUint32(this.length, value, true);
    this.length += 4;
  }

  i32(value: number): void {
    this.reserve(4);
    this.view.setInt32(this.length, value, true);
    this.length += 4;
  }

  /** `value` must be a safe integer. */
  i64(value: number): void {
    const high = Math.floor(value / twoPow32);
    this.u32(value - high * twoPow32);
    this.i32(high);
  }

  bigInt64(value: bigint): void {
    this.u32(Number(BigInt.asUintN(32, value)));
    this.i32(Number(BigInt.asIntN(32, value >> 32n)));
  }

  bytes(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
  }

  /** `value` must be an integer in `[0, 2^35)`. */
  varUint(value: number): void {
    this.reserve(maxVarintBytes);
    let rest = value;
    while (rest >= 0x80) {
      this.buffer[this.length] = (rest % 0x80) | 0x80;
      this.length += 1;
      rest = Math.floor(rest / 0x80);
    }
    this.buffer[this.length] = rest;
    this.length += 1;
  }

  varInt(value: number): void {
    this.varUint(zigzag(value));
  }

  /** Overwrites a `u32` written earlier at `offset`. */
  patchU32(offset: number, value: number): void {
    this.view.setUint32(offset, value, true);
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

export type ReadFailure = (reason: string, offset: number) => Error;

/** Bounds-checked little-endian reader over `bytes[start, end)`; every malformed read throws the error built by `fail`. */
export class ByteReader {
  private readonly view: DataView;
  offset: number;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly fail: ReadFailure,
    start = 0,
    readonly end = bytes.length,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = start;
  }

  get remaining(): number {
    return this.end - this.offset;
  }

  private advance(bytes: number): number {
    const at = this.offset;
    if (at + bytes > this.end) throw this.fail("unexpected end of data", at);
    this.offset = at + bytes;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.advance(1));
  }

  u16(): number {
    return this.view.getUint16(this.advance(2), true);
  }

  u32(): number {
    return this.view.getUint32(this.advance(4), true);
  }

  i32(): number {
    return this.view.getInt32(this.advance(4), true);
  }

  i64(): number {
    const at = this.advance(8);
    const value = this.view.getInt32(at + 4, true) * twoPow32 + this.view.getUint32(at, true);
    if (!Number.isSafeInteger(value)) throw this.fail("64-bit integer out of the safe range", at);
    return value;
  }

  bigInt64(): bigint {
    const at = this.advance(8);
    return (BigInt(this.view.getInt32(at + 4, true)) << 32n) + BigInt(this.view.getUint32(at, true));
  }

  take(length: number): Uint8Array {
    const at = this.advance(length);
    return this.bytes.subarray(at, at + length);
  }

  /** Rejects overlong and non-minimal encodings, so every value has a single encoding. */
  varUint(): number {
    const at = this.offset;
    let value = 0;
    let scale = 1;
    for (let index = 0; index < maxVarintBytes; index += 1) {
      if (this.offset >= this.end) throw this.fail("unexpected end of data", at);
      const byte = this.bytes[this.offset] ?? 0;
      this.offset += 1;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) {
        if (byte === 0 && index > 0) throw this.fail("non-minimal varint", at);
        return value;
      }
      scale *= 0x80;
    }
    throw this.fail("varint longer than 35 bits", at);
  }

  varInt(): number {
    return unzigzag(this.varUint());
  }
}
