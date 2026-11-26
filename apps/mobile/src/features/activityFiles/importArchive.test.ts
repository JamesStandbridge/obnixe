import { beforeEach, describe, expect, it } from "vitest";
import { archiveErrorReasons, importErrorReasons, openGarminArchive } from "@obnixe/core";
import type { ArchiveControl, ArchiveSource, OpenedArchive, ScratchSpace } from "@obnixe/core";
import { recording, settings } from "@obnixe/schema";
import { analyseArchive, archiveControl, archiveErrorMessage, archiveRefusalMessage, importArchiveActivities, undoArchive } from "@/features/activityFiles/importArchive";
import { readTrackFile } from "@/features/tracking/trackStore";
import { db, environment } from "../../../test/mocks/database.ts";

const encoder = new TextEncoder();
const metersPerDegree = 111_195;
const startedAt = Date.UTC(2026, 4, 3, 6);

function runGpx(start: number): Uint8Array {
  const points = Array.from({ length: 300 }, (_, index) => `<trkpt lat="${(45.1885 + (index * 3) / metersPerDegree).toFixed(7)}" lon="5.7245000"><time>${new Date(start + index * 1000).toISOString()}</time></trkpt>`);
  return encoder.encode(`<?xml version="1.0"?><gpx version="1.1" creator="watch" xmlns="http://www.topografix.com/GPX/1/1"><trk><type>running</type><trkseg>${points.join("")}</trkseg></trk></gpx>`);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP of stored entries, as an archive tool writes nested archives. */
function storedZip(entries: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [path, data] of Object.entries(entries)) {
    const name = encoder.encode(path);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directorySize = centrals.reduce((sum, central) => sum + central.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const zip = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  parts.reduce((position, part) => (zip.set(part, position), position + part.length), 0);
  return zip;
}

function memory(bytes: Uint8Array): ArchiveSource {
  return { size: bytes.length, read: async (offset, length) => bytes.slice(offset, offset + length) };
}

const scratch: ScratchSpace = async () => {
  const chunks: Uint8Array[] = [];
  return {
    append: async (bytes) => void chunks.push(bytes.slice()),
    finish: async () => {
      const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      chunks.reduce((offset, chunk) => (joined.set(chunk, offset), offset + chunk.length), 0);
      return memory(joined);
    },
    discard: async () => undefined,
  };
};

const day = 86_400_000;
const exportBytes = (): Uint8Array =>
  storedZip({
    "DI_CONNECT/DI-Connect-Fitness/me_0_summarizedActivities.json": encoder.encode(JSON.stringify([{ summarizedActivitiesExport: [{ activityId: 31, name: "Footing", startTimeGmt: startedAt }] }])),
    "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip": storedZip({ "me_1.gpx": runGpx(startedAt), "me_2.gpx": runGpx(startedAt + day) }),
  });

const quiet: ArchiveControl = archiveControl(
  () => false,
  () => undefined,
);

beforeEach(() => {
  db()
    .insert(settings)
    .values({ singleton: 1, theme: "dark", massUnit: "kg", agentCanReadBody: false, agentCanWrite: false, agentCanReadPhotos: false, reminderWeekdays: 0, reminderMinutes: 1110, remindersExportedAt: null, agentChangesSeenAt: null, bridgeHost: null, updatedAt: environment.now() })
    .run();
});

describe("archive messages (IO-013)", () => {
  it("names every reason an archive or one of its files is refused", () => {
    for (const reason of archiveErrorReasons) expect(archiveErrorMessage(reason).length).toBeGreaterThan(0);
    for (const reason of [...archiveErrorReasons, ...importErrorReasons]) expect(archiveRefusalMessage(reason).length).toBeGreaterThan(0);
  });
});

describe("Garmin archive import (IO-053, IO-025)", () => {
  it("imports through the track store, then undoes every batch and deletes the tracks", async () => {
    const archive: OpenedArchive = await openGarminArchive(memory(exportBytes()), scratch, quiet);
    const preview = await analyseArchive(archive, quiet);
    expect(preview.importable).toBe(2);
    const report = await importArchiveActivities(archive, preview, "ignore", quiet);
    await archive.close();
    expect(report.imported).toBe(2);
    const rows = db().select({ externalId: recording.externalId, trackFile: recording.trackFile }).from(recording).all();
    expect(rows.map((row) => row.externalId)).toContain("garmin:31");
    const files = report.batches.flatMap((batch) => batch.trackFiles);
    expect(files).toHaveLength(2);
    for (const file of files) expect(readTrackFile(file)).not.toBeNull();

    await undoArchive(report);
    for (const file of files) expect(readTrackFile(file)).toBeNull();
    expect((await analyseArchive(await openGarminArchive(memory(exportBytes()), scratch, quiet), quiet)).importable).toBe(2);
  });
});
