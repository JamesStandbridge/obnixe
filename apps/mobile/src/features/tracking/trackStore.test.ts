import { describe, expect, it } from "vitest";
import { decodeTrack, encodeTrack, toSampleColumns, trackDigest } from "@obnixe/core";
import type { Track } from "@obnixe/core";
import type { EpochMs, Id } from "@obnixe/schema";
import {
  deleteJournal,
  deleteTrack,
  journalSessionIds,
  journalUri,
  readJournal,
  readTrack,
  readTrackFile,
  storedTrackFiles,
  sweepTemporaryTracks,
  trackFileOf,
  writeTrack,
} from "@/features/tracking/trackStore";
import { Paths, storedFiles } from "../../../test/mocks/expoFileSystem.ts";

const recordingId = "0190a3f2-7c4e-7d21-9b1a-5f2e8c3d4a10" as Id;
const sessionId = "0190a3f2-7c4e-7d21-9b1a-5f2e8c3d4a11" as Id;

const track: Track = {
  startedAt: Date.UTC(2026, 10, 20, 7, 0) as EpochMs,
  samples: toSampleColumns([
    { type: "fix", t: 1000, fixAgeMs: 0, latitudeE7: 451_885_000, longitudeE7: 57_245_000, altitudeEllipsoidMm: 250_000, altitudeMslMm: null, horizontalAccuracyDm: 40, verticalAccuracyDm: null, speedCmS: 280, speedAccuracyCmS: null, bearingCentiDeg: null, bearingAccuracyCentiDeg: null, simulated: false },
    { type: "heart_rate", t: 1500, bpm: 132, contact: "contact", rrInterval: null },
  ]),
  marks: [
    { kind: "start", t: 0 },
    { kind: "stop", t: 2000 },
  ],
};

describe("track store", () => {
  it("writes tracks where the agent reader finds them, under the document directory (DAT-020)", async () => {
    const bytes = encodeTrack(track);
    const stored = await writeTrack(recordingId, bytes);
    expect(stored).toEqual({ file: `tracks/${recordingId}.otrk`, sha256: trackDigest(bytes), bytes: bytes.length });
    expect(storedFiles.has(`${Paths.document.uri}/tracks/${recordingId}.otrk`)).toBe(true);
    const read = readTrackFile(stored.file);
    expect(read).toEqual(bytes);
    expect(decodeTrack(read ?? new Uint8Array())).toEqual(track);
    expect(await readTrack(stored.file)).toEqual(bytes);
    expect(await storedTrackFiles()).toEqual([trackFileOf(recordingId)]);
  });

  it("replaces an existing track and leaves no temporary file", async () => {
    await writeTrack(recordingId, new Uint8Array([1, 2, 3]));
    const rewritten = await writeTrack(recordingId, encodeTrack(track));
    expect(readTrackFile(rewritten.file)).toEqual(encodeTrack(track));
    expect([...storedFiles.keys()].filter((uri) => uri.endsWith(".tmp"))).toEqual([]);
  });

  it("sweeps temporary files and deletes tracks (annex C, INT-031)", async () => {
    const stored = await writeTrack(recordingId, encodeTrack(track));
    storedFiles.set(`${Paths.document.uri}/tracks/${recordingId}.otrk.tmp`, new Uint8Array([9]));
    await sweepTemporaryTracks();
    expect([...storedFiles.keys()]).toEqual([`${Paths.document.uri}/${stored.file}`]);
    await deleteTrack(stored.file);
    expect(readTrackFile(stored.file)).toBeNull();
  });

  it("keeps one raw journal per session", async () => {
    const uri = journalUri(sessionId);
    expect(uri).toBe(`${Paths.document.uri}/recordings/${sessionId}.ojr`);
    expect(await readJournal(sessionId)).toBeNull();
    storedFiles.set(uri, new Uint8Array([4, 2]));
    expect(await journalSessionIds()).toEqual([sessionId]);
    expect(await readJournal(sessionId)).toEqual(new Uint8Array([4, 2]));
    await deleteJournal(sessionId);
    expect(await journalSessionIds()).toEqual([]);
  });
});
