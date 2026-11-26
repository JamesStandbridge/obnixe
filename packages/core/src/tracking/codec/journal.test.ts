import { describe, expect, it } from "vitest";
import type { EpochMs, Id } from "@obnixe/schema";
import type { Fix, Sample, TrackerMark } from "../types.ts";
import { crc32 } from "./crc32.ts";
import { encodeJournalBatch, encodeJournalHeader, JournalCorruptedError, readJournal } from "./journal.ts";
import type { JournalHeader, JournalRecord } from "./journal.ts";
import { syntheticActivity } from "./testSamples.ts";

const header: JournalHeader = {
  sessionId: "019abc12-3456-7def-8123-456789abcdef" as Id,
  startedAt: Date.UTC(2026, 10, 26, 7, 30) as EpochMs,
  monotonicOriginNs: 987_654_321_012_345_678n,
  platform: "android",
  device: "Pixel 9 Pro · Android 16",
};

const fix: Fix = {
  type: "fix",
  t: 1234,
  fixAgeMs: -12,
  latitudeE7: 458_326_000,
  longitudeE7: -68_652_000,
  altitudeEllipsoidMm: -4_200,
  altitudeMslMm: null,
  horizontalAccuracyDm: 42,
  verticalAccuracyDm: null,
  speedCmS: 310,
  speedAccuracyCmS: 70_000,
  bearingCentiDeg: 35_999,
  bearingAccuracyCentiDeg: null,
  simulated: true,
};

const toRecords = (samples: readonly Sample[], marks: readonly TrackerMark[]): JournalRecord[] => [
  ...marks.filter((mark) => mark.kind === "start").map((mark): JournalRecord => ({ type: "mark", ...mark })),
  ...samples,
  ...marks.filter((mark) => mark.kind !== "start").map((mark): JournalRecord => ({ type: "mark", ...mark })),
];

interface BuiltJournal {
  readonly bytes: Uint8Array;
  readonly headerLength: number;
  /** End offset of each batch. */
  readonly batchEnds: readonly number[];
  readonly batches: readonly (readonly JournalRecord[])[];
}

function buildJournal(records: readonly JournalRecord[], batchSize: number): BuiltJournal {
  const parts = [encodeJournalHeader(header)];
  const batches: JournalRecord[][] = [];
  for (let start = 0; start < records.length; start += batchSize) batches.push(records.slice(start, start + batchSize));
  const batchEnds: number[] = [];
  let length = parts[0]?.length ?? 0;
  for (const [sequence, batch] of batches.entries()) {
    const bytes = encodeJournalBatch(sequence, batch);
    parts.push(bytes);
    length += bytes.length;
    batchEnds.push(length);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { bytes, headerLength: parts[0]?.length ?? 0, batchEnds, batches };
}

const splitRecords = (records: readonly JournalRecord[]): { samples: Sample[]; marks: TrackerMark[] } => ({
  samples: records.filter((record): record is Sample => record.type !== "mark"),
  marks: records.flatMap((record) => (record.type === "mark" ? [{ kind: record.kind, t: record.t }] : [])),
});

const activity = syntheticActivity({ seconds: 40, seed: 7, heartRate: true });
const journal = buildJournal(toRecords(activity.samples, activity.marks), 16);

function resign(bytes: Uint8Array, batchStart: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const recordsEnd = batchStart + 8 + view.getUint32(batchStart, true);
  view.setUint32(recordsEnd, crc32(bytes, batchStart, recordsEnd), true);
}

describe("raw journal .ojr", () => {
  it("reads back the header, samples and marks it was written with", () => {
    const contents = readJournal(journal.bytes);
    expect(contents.header).toEqual(header);
    expect(contents.samples).toEqual(activity.samples);
    expect(contents.marks).toEqual(activity.marks);
    expect(contents.lastSequence).toBe(journal.batches.length - 1);
    expect(contents.validLength).toBe(journal.bytes.length);
  });

  it("restores absent fields, the simulated flag, clamped u16 values and every heart-rate contact", () => {
    const heartRates: JournalRecord[] = [
      { type: "heart_rate", t: 10, bpm: 151, contact: "contact", rrInterval: 412 },
      { type: "heart_rate", t: 11, bpm: 0, contact: "absent", rrInterval: null },
      { type: "heart_rate", t: 12, bpm: 149, contact: "unsupported", rrInterval: null },
    ];
    const built = buildJournal([fix, ...heartRates], 16);
    expect(readJournal(built.bytes).samples).toEqual([{ ...fix, speedAccuracyCmS: 0xfffe }, ...heartRates]);
  });

  it("restores the power with and without crank cadence and the cadence records, clamped to u16", () => {
    const sensors: JournalRecord[] = [
      { type: "power", t: 20, watts: 245, cadence: 91 },
      { type: "power", t: 21, watts: 0, cadence: null },
      { type: "power", t: 22, watts: 70_000, cadence: 0 },
      { type: "cadence", t: 23, perMinute: 172 },
      { type: "cadence", t: 24, perMinute: 70_000 },
    ];
    expect(readJournal(buildJournal(sensors, 16).bytes).samples).toEqual([
      ...sensors.slice(0, 2),
      { type: "power", t: 22, watts: 0xfffe, cadence: 0 },
      sensors[3],
      { type: "cadence", t: 24, perMinute: 0xfffe },
    ]);
  });

  it("pins the byte layout of the power and cadence records", () => {
    const batch = encodeJournalBatch(0, [
      { type: "power", t: 300, watts: 251, cadence: null },
      { type: "cadence", t: 301, perMinute: 88 },
    ]);
    expect(batch.length).toBe(8 + 9 + 7 + 4);
    expect(Array.from(batch.subarray(8, 24))).toEqual([6, 0x2c, 0x01, 0, 0, 0xfb, 0, 0xff, 0xff, 7, 0x2d, 0x01, 0, 0, 88, 0]);
  });

  it("pins the byte layout shared with the native writers", () => {
    const headerBytes = encodeJournalHeader(header);
    const device = new TextEncoder().encode(header.device);
    expect(headerBytes.length).toBe(4 + 1 + 16 + 8 + 8 + 1 + 1 + device.length + 4);
    expect(Array.from(headerBytes.subarray(0, 5))).toEqual([0x4f, 0x4a, 0x52, 0x4e, 1]);
    expect(Array.from(headerBytes.subarray(5, 9))).toEqual([0x01, 0x9a, 0xbc, 0x12]);
    expect(headerBytes[37]).toBe(1);
    expect(headerBytes[38]).toBe(device.length);
    const batch = encodeJournalBatch(3, [fix, { type: "mark", kind: "stop", t: 2000 }]);
    const view = new DataView(batch.buffer);
    expect(batch.length).toBe(8 + 38 + 6 + 4);
    expect(view.getUint32(0, true)).toBe(44);
    expect(view.getUint32(4, true)).toBe(3);
    expect(batch[8]).toBe(1);
    expect(view.getUint32(9, true)).toBe(1234);
    expect(view.getInt32(13, true)).toBe(-12);
    expect(view.getInt32(17, true)).toBe(458_326_000);
    expect(view.getInt32(25, true)).toBe(-4_200);
    expect(view.getInt32(29, true)).toBe(-2_147_483_648);
    expect(view.getUint16(33, true)).toBe(42);
    expect(view.getUint16(35, true)).toBe(0xffff);
    expect(view.getUint16(39, true)).toBe(0xfffe);
    expect(batch[45]).toBe(1);
    expect(Array.from(batch.subarray(46, 52))).toEqual([5, 0xd0, 0x07, 0, 0, 5]);
    expect(view.getUint32(52, true)).toBe(crc32(batch, 0, 52));
  });

  it("REC-080 reads every truncated prefix without error and returns its complete batches", () => {
    for (let length = 0; length <= journal.bytes.length; length += 1) {
      const contents = readJournal(journal.bytes.subarray(0, length));
      if (length < journal.headerLength) {
        expect(contents.header).toBeNull();
        continue;
      }
      const complete = journal.batchEnds.filter((end) => end <= length).length;
      const expected = splitRecords(journal.batches.slice(0, complete).flat());
      expect(contents.header).toEqual(header);
      expect(contents.lastSequence).toBe(complete === 0 ? null : complete - 1);
      expect(contents.validLength).toBe(complete === 0 ? journal.headerLength : journal.batchEnds[complete - 1]);
      expect(contents.samples).toEqual(expected.samples);
      expect(contents.marks).toEqual(expected.marks);
    }
  });

  it("REC-080 ignores the batch after a bad CRC and everything that follows", () => {
    const bytes = journal.bytes.slice();
    const secondBatchStart = journal.batchEnds[0] ?? 0;
    bytes[secondBatchStart + 20] = (bytes[secondBatchStart + 20] ?? 0) ^ 0x01;
    const contents = readJournal(bytes);
    expect(contents.lastSequence).toBe(0);
    expect(contents.validLength).toBe(secondBatchStart);
    expect(contents.samples).toEqual(splitRecords(journal.batches[0] ?? []).samples);
  });

  it("stops at a batch that breaks the sequence", () => {
    const bytes = journal.bytes.slice();
    const view = new DataView(bytes.buffer);
    const thirdBatchStart = journal.batchEnds[1] ?? 0;
    view.setUint32(thirdBatchStart + 4, 7, true);
    resign(bytes, thirdBatchStart);
    expect(readJournal(bytes).lastSequence).toBe(1);
  });

  it("stops at a CRC-valid batch with an unknown record type, a reserved mark kind, a bad enum or a record going back in time", () => {
    const start = journal.headerLength;
    const corrupt = (edit: (bytes: Uint8Array) => void): number | null => {
      const built = buildJournal([fix, { type: "mark", kind: "lap", t: 1500 }, { ...fix, t: 1600 }], 3);
      const bytes = built.bytes.slice();
      edit(bytes);
      resign(bytes, start);
      return readJournal(bytes).lastSequence;
    };
    expect(corrupt(() => undefined)).toBe(0);
    expect(corrupt((bytes) => (bytes[start + 8] = 9))).toBeNull();
    expect(corrupt((bytes) => (bytes[start + 8 + 38 + 5] = 4))).toBeNull();
    expect(corrupt((bytes) => (bytes[start + 8 + 37] = 0x03))).toBeNull();
    expect(corrupt((bytes) => new DataView(bytes.buffer).setUint32(start + 8 + 44 + 1, 1000, true))).toBeNull();
    expect(corrupt((bytes) => new DataView(bytes.buffer).setInt32(start + 8 + 9, 900_000_001, true))).toBeNull();
  });

  it("stops at a batch whose records do not exactly fill its length", () => {
    const bytes = journal.bytes.slice();
    const view = new DataView(bytes.buffer);
    const start = journal.headerLength;
    view.setUint32(start, view.getUint32(start, true) - 1, true);
    resign(bytes, start);
    expect(readJournal(bytes).lastSequence).toBeNull();
  });

  it("returns only the batches after a sequence when asked", () => {
    const contents = readJournal(journal.bytes, { afterSequence: 1 });
    const expected = splitRecords(journal.batches.slice(2).flat());
    expect(contents.samples).toEqual(expected.samples);
    expect(contents.marks).toEqual(expected.marks);
    expect(contents.lastSequence).toBe(journal.batches.length - 1);
  });

  it("refuses a file whose header is not a journal header", () => {
    const corrupted = (offset: number, value: number): Uint8Array => {
      const bytes = journal.bytes.slice();
      bytes[offset] = value;
      return bytes;
    };
    expect(() => readJournal(corrupted(0, 0x00))).toThrow(new JournalCorruptedError("magic"));
    expect(() => readJournal(corrupted(4, 2))).toThrow(new JournalCorruptedError("version"));
    expect(() => readJournal(corrupted(10, 0x55))).toThrow(new JournalCorruptedError("header_crc"));
    expect(() => readJournal(new Uint8Array(16))).toThrow(JournalCorruptedError);
  });

  it("DAT-021 stays under 1.5 MB per hour at 1 Hz with barometer, pedometer and heart rate", () => {
    const hour = syntheticActivity({ seconds: 3600, seed: 3, heartRate: true });
    const built = buildJournal(toRecords(hour.samples, hour.marks), 16);
    expect(built.bytes.length).toBeLessThan(1_500_000);
    expect(readJournal(built.bytes).samples.length).toBe(hour.samples.length);
  });
});
