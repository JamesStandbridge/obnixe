import { describe, expect, it } from "vitest";
import { crc32 } from "./crc32.ts";
import { ByteReader, ByteWriter, unzigzag, zigzag } from "./varint.ts";

class ReadError extends Error {}

const reader = (bytes: readonly number[]): ByteReader => new ByteReader(Uint8Array.from(bytes), (reason) => new ReadError(reason));

describe("crc32", () => {
  it("matches the IEEE check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("covers only the requested range", () => {
    const bytes = new TextEncoder().encode("xx123456789yy");
    expect(crc32(bytes, 2, 11)).toBe(0xcbf43926);
  });
});

describe("varints", () => {
  it("zigzag maps signed integers onto unsigned ones and back", () => {
    expect([0, -1, 1, -2, 2].map(zigzag)).toEqual([0, 1, 2, 3, 4]);
    for (const value of [0, 1, -1, 63, -64, 2 ** 31 - 1, -(2 ** 31), 2 ** 32 - 1, -(2 ** 32) + 1]) expect(unzigzag(zigzag(value))).toBe(value);
  });

  it("round-trips unsigned and signed LEB128 up to 35 bits", () => {
    const unsigned = [0, 1, 127, 128, 300, 16_383, 16_384, 2 ** 31, 2 ** 32 - 1, 2 ** 33 + 5, 2 ** 35 - 1];
    const signed = [0, -1, 1, -64, 64, -(2 ** 31), 2 ** 31 - 1, -(2 ** 32) + 1, 2 ** 32 - 1];
    const writer = new ByteWriter(1);
    for (const value of unsigned) writer.varUint(value);
    for (const value of signed) writer.varInt(value);
    const bytes = writer.finish();
    const read = new ByteReader(bytes, (reason) => new ReadError(reason));
    expect(unsigned.map(() => read.varUint())).toEqual(unsigned);
    expect(signed.map(() => read.varInt())).toEqual(signed);
    expect(read.remaining).toBe(0);
  });

  it("encodes 300 as the canonical two bytes", () => {
    const writer = new ByteWriter();
    writer.varUint(300);
    expect(Array.from(writer.finish())).toEqual([0xac, 0x02]);
  });

  it("rejects non-minimal, overlong and truncated varints", () => {
    expect(() => reader([0x80, 0x00]).varUint()).toThrow(ReadError);
    expect(() => reader([0xff, 0xff, 0xff, 0xff, 0xff, 0x01]).varUint()).toThrow(ReadError);
    expect(() => reader([0x80]).varUint()).toThrow(ReadError);
  });

  it("round-trips little-endian fixed-width integers", () => {
    const writer = new ByteWriter(2);
    writer.u8(0xab);
    writer.u16(0xbeef);
    writer.u32(0xdeadbeef);
    writer.i32(-5);
    writer.i64(1_795_000_000_123);
    writer.i64(-3);
    writer.bigInt64(-(2n ** 62n) + 7n);
    const bytes = writer.finish();
    expect(Array.from(bytes.subarray(1, 3))).toEqual([0xef, 0xbe]);
    const read = new ByteReader(bytes, (reason) => new ReadError(reason));
    expect([read.u8(), read.u16(), read.u32(), read.i32(), read.i64(), read.i64()]).toEqual([0xab, 0xbeef, 0xdeadbeef, -5, 1_795_000_000_123, -3]);
    expect(read.bigInt64()).toBe(-(2n ** 62n) + 7n);
    expect(() => read.u8()).toThrow(ReadError);
  });
});
