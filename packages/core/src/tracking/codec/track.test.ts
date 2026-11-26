import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { EpochMs } from "@obnixe/schema";
import { toSampleColumns } from "../types.ts";
import type { Fix, Sample } from "../types.ts";
import { crc32 } from "./crc32.ts";
import { decodeTrack, encodeTrack, TrackDecodeError, TrackEncodeError } from "./track.ts";
import type { Track } from "./track.ts";
import { syntheticActivity } from "./testSamples.ts";
import { ByteWriter } from "./varint.ts";

const startedAt = Date.UTC(2026, 10, 26, 7, 30) as EpochMs;

const trackOf = (samples: readonly Sample[], marks: Track["marks"] = []): Track => ({ startedAt, samples: toSampleColumns(samples), marks });

const activity = syntheticActivity({ seconds: 600, seed: 11, heartRate: true });
const track = trackOf(activity.samples, activity.marks);
const encoded = encodeTrack(track);

const baseFix: Fix = {
  type: "fix",
  t: 0,
  fixAgeMs: 400,
  latitudeE7: 0,
  longitudeE7: 0,
  altitudeEllipsoidMm: null,
  altitudeMslMm: null,
  horizontalAccuracyDm: null,
  verticalAccuracyDm: null,
  speedCmS: null,
  speedAccuracyCmS: null,
  bearingCentiDeg: null,
  bearingAccuracyCentiDeg: null,
  simulated: false,
};

function resign(bytes: Uint8Array): Uint8Array {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(bytes.length - 4, crc32(bytes, 0, bytes.length - 4), true);
  return bytes;
}

interface ForgedStream {
  readonly kind: number;
  readonly count: number;
  readonly bytes: Uint8Array;
}

/** A well-formed container around arbitrary stream bytes, to reach the decoder's content checks. */
function forge(streams: readonly ForgedStream[], flags = 0): Uint8Array {
  const payload = new ByteWriter();
  for (const stream of streams) payload.bytes(stream.bytes);
  const compressed = deflateSync(payload.finish(), { level: 6 });
  const writer = new ByteWriter();
  writer.bytes(new TextEncoder().encode("OTRK"));
  writer.u8(1);
  writer.u8(flags);
  writer.i64(startedAt);
  writer.u16(streams.length);
  for (const stream of streams) {
    writer.u8(stream.kind);
    writer.u32(stream.count);
    writer.u32(stream.bytes.length);
  }
  writer.bytes(compressed);
  writer.u32(0);
  return resign(writer.finish());
}

function varints(values: readonly number[], signed: readonly boolean[]): Uint8Array {
  const writer = new ByteWriter();
  for (const [index, value] of values.entries()) {
    if (signed[index] === true) writer.varInt(value);
    else writer.varUint(value);
  }
  return writer.finish();
}

/** One fix with no optional column: t, presence, latitude, longitude, fix age. */
const oneFix = (latitudeE7: number, presence = 0): ForgedStream => ({ kind: 1, count: 1, bytes: varints([0, presence, latitudeE7, 0, 0], [false, false, true, true, true]) });

describe("track .otrk", () => {
  it("round-trips every stream and every column exactly", () => {
    const decoded = decodeTrack(encoded);
    expect(decoded).toEqual(track);
    expect(decoded.samples.fixes.altitudeMslMm).toBeInstanceOf(Int32Array);
  });

  it("round-trips absent values, simulated fixes, extreme coordinates and negative altitudes", () => {
    const samples: Sample[] = [
      { ...baseFix, t: 0, latitudeE7: 900_000_000, longitudeE7: -1_800_000_000, altitudeEllipsoidMm: -430_000 },
      { ...baseFix, t: 0, latitudeE7: -900_000_000, longitudeE7: 1_800_000_000, altitudeMslMm: 8_848_000, simulated: true, fixAgeMs: -2_147_483_648 },
      { ...baseFix, t: 4_294_967_295, horizontalAccuracyDm: 0, speedCmS: 2_147_483_647, bearingCentiDeg: 35_999 },
      { type: "heart_rate", t: 5, bpm: 0, contact: "absent", rrInterval: null },
      { type: "heart_rate", t: 6, bpm: 65_535, contact: "contact", rrInterval: 65_535 },
      { type: "pressure", t: 9, pascals: 4_294_967_295 },
      { type: "pressure", t: 9, pascals: 0 },
      { type: "steps", t: 2, count: 0 },
      { type: "steps", t: 3, count: 4_294_967_295 },
      { type: "power", t: 7, watts: 0, cadence: null },
      { type: "power", t: 8, watts: 65_535, cadence: 0 },
      { type: "power", t: 8, watts: 312, cadence: 65_534 },
      { type: "cadence", t: 1, perMinute: 0 },
      { type: "cadence", t: 2, perMinute: 65_535 },
    ];
    const edge = trackOf(samples, [{ kind: "start", t: 0 }, { kind: "stop", t: 4_294_967_295 }]);
    const decoded = decodeTrack(encodeTrack(edge));
    expect(decoded.samples).toEqual(edge.samples);
    expect(decoded.marks).toEqual(edge.marks);
    expect(decoded.samples.heartRate.rrInterval[0]).toBe(-2_147_483_648);
    expect(Array.from(decoded.samples.power.cadence)).toEqual([-2_147_483_648, 0, 65_534]);
  });

  it("encodes an empty track and decodes it to empty columns", () => {
    const empty = trackOf([]);
    const bytes = encodeTrack(empty);
    expect(decodeTrack(bytes)).toEqual(empty);
  });

  it("is deterministic: the same track always gives the same bytes", () => {
    expect(encodeTrack(decodeTrack(encoded))).toEqual(encoded);
  });

  it("round-trips the DEM altitude in its own stream and writes none for an uncorrected track (ELE-003)", () => {
    const { fixes } = track.samples;
    const terrain = { length: fixes.length, t: fixes.t.slice(), altitudeMm: Int32Array.from(fixes.t, (t, index) => 1_200_000 - index * 37 + (t % 7)) };
    const corrected: Track = { ...track, samples: { ...track.samples, terrain } };
    const bytes = encodeTrack(corrected);
    expect(decodeTrack(bytes)).toEqual(corrected);
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(14, true)).toBe(new DataView(encoded.buffer, encoded.byteOffset).getUint16(14, true) + 1);
    expect(decodeTrack(encoded).samples.terrain.length).toBe(0);
  });

  it("sets the ellipsoidal altitude and simulated flags from the fixes", () => {
    const flagsOf = (samples: readonly Sample[]): number => encodeTrack(trackOf(samples))[5] ?? -1;
    expect(flagsOf([{ ...baseFix, altitudeEllipsoidMm: 1000, altitudeMslMm: 950 }])).toBe(0);
    expect(flagsOf([{ ...baseFix, altitudeEllipsoidMm: 1000 }])).toBe(1);
    expect(flagsOf([{ ...baseFix, simulated: true }])).toBe(2);
  });

  it("DAT-021 stays under 60 KB per hour at 1 Hz with barometer and pedometer", () => {
    const hour = syntheticActivity({ seconds: 3600, seed: 5, heartRate: false });
    const bytes = encodeTrack(trackOf(hour.samples, hour.marks));
    expect(bytes.length).toBeLessThan(60_000);
    const withHeartRate = syntheticActivity({ seconds: 3600, seed: 5, heartRate: true });
    expect(encodeTrack(trackOf(withHeartRate.samples, withHeartRate.marks)).length).toBeLessThan(75_000);
  });

  it("refuses tracks the decoder would reject", () => {
    expect(() => encodeTrack(trackOf([{ ...baseFix, latitudeE7: 900_000_001 }]))).toThrow(TrackEncodeError);
    expect(() => encodeTrack(trackOf([{ ...baseFix, horizontalAccuracyDm: -1 }]))).toThrow(TrackEncodeError);
    expect(() => encodeTrack(trackOf([{ type: "steps", t: 0, count: 5 }, { type: "steps", t: 1, count: 4 }]))).toThrow(TrackEncodeError);
    expect(() => encodeTrack(trackOf([], [{ kind: "lap", t: 10 }, { kind: "stop", t: 9 }]))).toThrow(TrackEncodeError);
    expect(() => encodeTrack(trackOf([{ type: "power", t: 0, watts: 200, cadence: 65_535 }]))).toThrow(TrackEncodeError);
    expect(() => encodeTrack({ ...trackOf([]), startedAt: -1 as EpochMs })).toThrow(TrackEncodeError);
    const unordered = toSampleColumns([baseFix, { ...baseFix, t: 10 }]);
    unordered.fixes.t[1] = 0;
    unordered.fixes.t[0] = 10;
    expect(() => encodeTrack({ startedAt, samples: unordered, marks: [] })).toThrow(TrackEncodeError);
  });

  describe("DAT-040 strict decoder", () => {
    const rejects = (bytes: Uint8Array, reason: RegExp): void => {
      expect(() => decodeTrack(bytes)).toThrow(TrackDecodeError);
      expect(() => decodeTrack(bytes)).toThrow(reason);
    };

    it("checks the magic, the version, the flags and the CRC", () => {
      rejects(new Uint8Array(4), /too short/);
      rejects(resign(Uint8Array.from(encoded, (byte, index) => (index === 0 ? 0x58 : byte))), /not a track file/);
      rejects(resign(Uint8Array.from(encoded, (byte, index) => (index === 4 ? 2 : byte))), /unsupported version/);
      rejects(resign(Uint8Array.from(encoded, (byte, index) => (index === 5 ? 0x04 : byte))), /unknown flags/);
      rejects(resign(Uint8Array.from(encoded, (byte, index) => (index === 5 ? 0x02 : byte))), /flags do not match/);
      for (const offset of [6, 20, Math.floor(encoded.length / 2), encoded.length - 1]) {
        rejects(Uint8Array.from(encoded, (byte, index) => (index === offset ? byte ^ 0x10 : byte)), /CRC mismatch/);
      }
    });

    it("rejects every truncation", () => {
      for (let length = 0; length < encoded.length; length += 97) expect(() => decodeTrack(encoded.subarray(0, length))).toThrow(TrackDecodeError);
      expect(() => decodeTrack(encoded.subarray(0, encoded.length - 1))).toThrow(TrackDecodeError);
    });

    it("checks the stream table against the payload", () => {
      const stream = oneFix(10);
      expect(decodeTrack(forge([stream])).samples.fixes.length).toBe(1);
      rejects(forge([{ ...stream, kind: 9 }]), /unknown stream kind/);
      rejects(forge([stream, stream]), /strictly increasing/);
      rejects(forge([{ ...stream, count: 0 }]), /does not match its count/);
      rejects(forge([{ ...stream, count: 2, bytes: Uint8Array.from([...stream.bytes, ...varints([0, 0, 0, 0, 0], [])]) }]), /unexpected end|out of range|trailing/);
      rejects(forge([{ ...stream, bytes: Uint8Array.from([...stream.bytes, 0]) }]), /trailing bytes/);
      const bytes = forge([stream]);
      new DataView(bytes.buffer).setUint32(16 + 5, stream.bytes.length + 1, true);
      rejects(resign(bytes), /inflates to/);
    });

    it("checks coordinate bounds, presence bits, value ranges and mark kinds", () => {
      rejects(forge([oneFix(900_000_001)]), /latitude 0 is out of range/);
      rejects(forge([oneFix(0, 1 << 9)]), /unknown presence bits/);
      rejects(forge([{ kind: 4, count: 1, bytes: varints([0, 65_536, 0], [false, true, true]) }]), /heart rate 0 is out of range/);
      rejects(forge([{ kind: 1, count: 1, bytes: varints([0, 0b1, 0, 0, 0, -2_147_483_648], [false, false, true, true, true, true]) }]), /altitudeEllipsoidMm 0 is out of range/);
      rejects(forge([{ kind: 5, count: 1, bytes: varints([0, 4], []) }]), /unknown kind/);
      rejects(forge([{ kind: 6, count: 1, bytes: varints([0, 65_536, 0], [false, true, true]) }]), /power 0 is out of range/);
      rejects(forge([{ kind: 6, count: 1, bytes: varints([0, 0, -1], [false, true, true]) }]), /power cadence 0 is out of range/);
      rejects(forge([{ kind: 7, count: 1, bytes: varints([0, 65_536], [false, true]) }]), /cadence 0 is out of range/);
      rejects(forge([{ kind: 3, count: 2, bytes: varints([4_294_967_295, 1, 0, 0], []) }]), /time 1 overflows/);
    });
  });
});
