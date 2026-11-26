import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Sample, TrackerMark } from "../types.ts";
import { readJournal } from "./journal.ts";
import type { JournalHeader } from "./journal.ts";

/** What the reader must return for a fixture; JSON has no `bigint`, so the monotonic origin is a decimal string. */
interface ExpectedJournal {
  readonly header: Omit<JournalHeader, "monotonicOriginNs"> & { readonly monotonicOriginNs: string };
  readonly samples: readonly Sample[];
  readonly marks: readonly TrackerMark[];
  readonly lastSequence: number;
  readonly validLength: number;
}

const fixture = (name: string): URL => new URL(`../../../test/fixtures/journal/${name}`, import.meta.url);

/** Written by the Android tracker's `JournalWriter` (`JournalFixtureTest` regenerates both files). */
describe("journal written by the Android tracker", () => {
  const bytes = new Uint8Array(readFileSync(fixture("android-v1.ojr")));
  const expected = JSON.parse(readFileSync(fixture("android-v1.json"), "utf8")) as ExpectedJournal;

  it("reads back every sample and mark the writer wrote", () => {
    expect(readJournal(bytes)).toEqual({ ...expected, header: { ...expected.header, monotonicOriginNs: BigInt(expected.header.monotonicOriginNs) } });
  });

  it("reads every truncation of it as a prefix of its batches", () => {
    for (let length = 0; length < expected.validLength; length += 1) {
      const contents = readJournal(bytes.subarray(0, length));
      expect(contents.lastSequence ?? -1).toBeLessThan(expected.lastSequence);
      expect(contents.samples).toEqual(expected.samples.slice(0, contents.samples.length));
      expect(contents.marks).toEqual(expected.marks.slice(0, contents.marks.length));
    }
  });
});
