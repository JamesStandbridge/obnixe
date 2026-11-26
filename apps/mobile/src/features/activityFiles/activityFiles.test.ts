import { eq } from "drizzle-orm";
import { File, Paths } from "expo-file-system";
import { shareAsync } from "expo-sharing";
import { unzipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeImport, decodeTrack, exportableSessions, ImportError, readActivityFile, revert, trackFilePath } from "@obnixe/core";
import type { ImportComputation, ImportErrorReason } from "@obnixe/core";
import { recording, session, settings } from "@obnixe/schema";
import type { Id, LocalDate } from "@obnixe/schema";
import { activityFile } from "@/features/activityFiles/exportActivity";
import { archivePeriods, periodStart, writeArchive } from "@/features/activityFiles/exportArchive";
import { createStreamedFile } from "@/features/data/files";
import type { StreamedFile } from "@/features/data/files";
import { commitImport, decisionOf, defaultResolution, importErrorMessage, importSports, matchedSession, matchImport, previewPath, readActivity, resolutionsOf, sportChoice } from "@/features/activityFiles/importActivity";
import type { ImportMatch } from "@/features/activityFiles/importActivity";
import { openedFileRoute } from "@/features/activityFiles/openedFiles";
import { readTrackFile } from "@/features/tracking/trackStore";
import { db, environment } from "../../../test/mocks/database.ts";
import { storedFiles } from "../../../test/mocks/expoFileSystem.ts";

vi.mock("expo-sharing", () => ({ shareAsync: vi.fn(async () => undefined) }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: vi.fn() }));

const startedAt = Date.UTC(2026, 9, 1, 7);
const home = { latitude: 45.1885, longitude: 5.7245 };
const metersPerDegree = 111_195;

interface GpxShape {
  readonly seconds: number;
  readonly offsetMs?: number;
  readonly heartRate?: number;
  readonly creator?: string;
}

/** A run north from home at 3 m/s, one point per second. */
function gpxOf({ seconds, offsetMs = 0, heartRate, creator = "test" }: GpxShape): Uint8Array {
  const points = Array.from({ length: seconds }, (_, index) => {
    const latitude = home.latitude + (index * 3) / metersPerDegree;
    const extension = heartRate === undefined ? "" : `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${heartRate}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>`;
    return `<trkpt lat="${latitude.toFixed(7)}" lon="${home.longitude.toFixed(7)}"><ele>250</ele><time>${new Date(startedAt + offsetMs + index * 1000).toISOString()}</time>${extension}</trkpt>`;
  });
  return new TextEncoder().encode(
    `<?xml version="1.0"?><gpx version="1.1" creator="${creator}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk><name>Footing</name><type>running</type><trkseg>${points.join("")}</trkseg></trk></gpx>`,
  );
}

function measured(bytes: Uint8Array): ImportComputation {
  return computeImport(readActivityFile(bytes), { sport: "run", values: {} });
}

async function imported(bytes: Uint8Array): Promise<Id> {
  const computation = measured(bytes);
  const decision = decisionOf(matchImport(computation), "keep", null, false);
  if (decision === null) throw new Error("Nothing to import");
  return (await commitImport(computation, decision)).sessionId;
}

function liveSessions(): readonly Id[] {
  return db()
    .select({ id: session.id, deletedAt: session.deletedAt })
    .from(session)
    .all()
    .filter((row) => row.deletedAt === null)
    .map((row) => row.id);
}

beforeEach(() => {
  db()
    .insert(settings)
    .values({ singleton: 1, theme: "dark", massUnit: "kg", agentCanReadBody: false, agentCanWrite: false, agentCanReadPhotos: false, reminderWeekdays: 0, reminderMinutes: 1110, remindersExportedAt: null, agentChangesSeenAt: null, bridgeHost: null, updatedAt: environment.now() })
    .run();
});

describe("reading a file", () => {
  it("names what is wrong with a refused file (IO-013)", () => {
    const reasons: readonly ImportErrorReason[] = ["unsupported_format", "malformed", "checksum", "truncated", "not_an_activity", "several_activities", "no_activity_data", "untimed", "unordered_time", "invalid_coordinates", "invalid_value"];
    const messages = reasons.map(importErrorMessage);
    expect(new Set(messages).size).toBe(reasons.length);
    expect(readActivity(new TextEncoder().encode("hello"))).toEqual({ kind: "refused", message: importErrorMessage("unsupported_format") });
    expect(() => readActivityFile(new TextEncoder().encode("hello"))).toThrow(ImportError);
  });

  it("offers the measured sports with the detected one first (IO-010)", () => {
    const reading = readActivity(gpxOf({ seconds: 60 }));
    if (reading.kind !== "read") throw new Error(reading.message);
    expect(reading.activity.sport?.sport).toBe("run");
    expect(importSports(null)).toContain("run");
    expect(importSports(null)).not.toContain("strength");
    expect(importSports({ sport: "strength", values: {} })[0]).toBe("strength");
    expect(sportChoice({ sport: "bike", values: { kind: "gravel" } }, "bike")).toEqual({ sport: "bike", values: { kind: "gravel" } });
    expect(sportChoice({ sport: "bike", values: { kind: "gravel" } }, "run")).toEqual({ sport: "run", values: {} });
  });

  it("simplifies the preview line and frames it", () => {
    const path = previewPath(measured(gpxOf({ seconds: 600 })));
    if (path === null) throw new Error("No preview");
    expect(path.coordinates.length).toBeLessThan(20);
    const [west, south, east, north] = path.bounds;
    expect(west).toBeCloseTo(home.longitude, 6);
    expect(east).toBeCloseTo(home.longitude, 6);
    expect(south).toBeCloseTo(home.latitude, 4);
    expect(north - south).toBeGreaterThan(0.015);
  });
});

describe("importing", () => {
  it("writes the track where the recording points, then commits (DAT-020)", async () => {
    const computation = measured(gpxOf({ seconds: 600 }));
    expect(matchImport(computation)).toEqual({ kind: "new" });
    const result = await commitImport(computation, { kind: "import", replaceSessionId: null });
    const row = db().select().from(recording).where(eq(recording.sessionId, result.sessionId)).get();
    if (row?.trackFile == null) throw new Error("No track file");
    expect(row.trackFile).toBe(trackFilePath(row.id));
    expect(readTrackFile(row.trackFile)?.length).toBe(row.trackBytes);
    expect(decodeTrack(readTrackFile(row.trackFile) ?? new Uint8Array()).samples.fixes.t.length).toBe(600);
  });

  it("settles a file imported twice: ignored by default, or replaced (IO-012)", async () => {
    const bytes = gpxOf({ seconds: 600 });
    const first = await imported(bytes);
    const again = measured(bytes);
    const match = matchImport(again);
    expect(match).toEqual({ kind: "already_imported", sessionId: first });
    expect(defaultResolution(match)).toBe("ignore");
    expect(decisionOf(match, "ignore", matchedSession(match, again.activity.startedAt), false)).toBeNull();
    const decision = decisionOf(match, "replace", matchedSession(match, again.activity.startedAt), false);
    expect(decision).toEqual({ kind: "import", replaceSessionId: first });
    if (decision === null) throw new Error("No decision");
    const replaced = await commitImport(again, decision);
    expect(liveSessions()).toEqual([replaced.sessionId]);
  });

  it("finds a probable duplicate from another device, keeps both on demand (IO-012)", async () => {
    const first = await imported(gpxOf({ seconds: 600 }));
    const other = measured(gpxOf({ seconds: 610, offsetMs: 30_000, creator: "Strava", heartRate: 140 }));
    const match = matchImport(other);
    expect(match).toEqual({ kind: "probable", sessionIds: [first] });
    expect(resolutionsOf(match).map((option) => option.value)).toEqual(["ignore", "replace", "keep"]);
    expect(matchedSession(match, other.activity.startedAt)).toEqual({ sessionId: first, startedAt });
    const kept = await commitImport(other, { kind: "import", replaceSessionId: null });
    expect([...liveSessions()].sort()).toEqual([first, kept.sessionId].sort());
  });

  it("completes a phone recording with the watch heart rate, and undoes it (IO-052)", async () => {
    const phone = await imported(gpxOf({ seconds: 600 }));
    db().update(recording).set({ source: "live", importFormat: null, externalId: null }).where(eq(recording.sessionId, phone)).run();
    const before = db().select().from(recording).where(eq(recording.sessionId, phone)).get();
    const watch = measured(gpxOf({ seconds: 600, offsetMs: 2000, heartRate: 141, creator: "Garmin Connect" }));
    const match = matchImport(watch);
    if (match.kind !== "merge") throw new Error(`Expected a merge, got ${match.kind}`);
    expect(match.merge).toMatchObject({ sessionId: phone, addsHeartRate: true });
    expect(defaultResolution(match)).toBe("merge");
    const decision = decisionOf(match, "merge", matchedSession(match, watch.activity.startedAt), true);
    expect(decision).toEqual({ kind: "merge", merge: match.merge, replaceAltitude: match.merge.offersAltitude });
    if (decision === null) throw new Error("No decision");
    const result = await commitImport(watch, decision);
    expect(result.sessionId).toBe(phone);
    const merged = db().select().from(recording).where(eq(recording.sessionId, phone)).get();
    if (merged?.trackFile == null || before?.trackFile == null) throw new Error("No track file");
    expect(merged.heartRateSource).toBe("file");
    expect(merged.trackFile).toBe(trackFilePath(merged.id));
    expect(merged.trackFile).not.toBe(before.trackFile);
    expect(decodeTrack(readTrackFile(merged.trackFile) ?? new Uint8Array()).samples.heartRate.bpm.length).toBeGreaterThan(0);
    revert(db(), environment, { actor: { author: "user", connectionId: null }, changesetId: result.changesetId, summary: result.summary, restoredVersionSummary: (number) => `v${number}` });
    expect(db().select().from(recording).where(eq(recording.sessionId, phone)).get()?.trackFile).toBe(before.trackFile);
    expect(readTrackFile(before.trackFile)).not.toBeNull();
  });
});

describe("exporting", () => {
  it("names the file and hides the ends unless the full track is included (IO-002, PRV-011)", async () => {
    const id = await imported(gpxOf({ seconds: 600 }));
    db().update(settings).set({ hideTrackEndsMeters: 200 }).run();
    const masked = await activityFile(id, "gpx", false);
    const full = await activityFile(id, "gpx", true);
    expect(full).toMatchObject({ name: "obnixe-2026-10-01-footing.gpx", mimeType: "application/gpx+xml", startedAt });
    const pointCount = (bytes: Uint8Array): number => new TextDecoder().decode(bytes).split("<trkpt").length - 1;
    expect(pointCount(full.bytes)).toBe(600);
    expect(pointCount(masked.bytes)).toBeLessThan(600 - 100);
  });

  it.each(["fit", "tcx"] as const)("exports %s files that import back with the same points and mask (IO-003)", async (format) => {
    const id = await imported(gpxOf({ seconds: 600, heartRate: 150 }));
    db().update(settings).set({ hideTrackEndsMeters: 200 }).run();
    const full = await activityFile(id, format, true);
    const masked = await activityFile(id, format, false);
    expect(full.name).toBe(`obnixe-2026-10-01-footing.${format}`);
    const back = readActivity(full.bytes);
    if (back.kind !== "read") throw new Error(`Unreadable ${format}`);
    expect(back.activity).toMatchObject({ format, startedAt, sport: { sport: "run" } });
    expect(back.activity.points).toHaveLength(600);
    expect(back.activity.points.every((point) => point.heartRate === 150)).toBe(true);
    expect(readActivityFile(masked.bytes).points.length).toBeLessThan(600 - 100);
  });
});

class MemoryFile implements StreamedFile {
  chunks: Uint8Array[] = [];
  shared = false;

  async write(chunks: readonly Uint8Array[]): Promise<void> {
    this.chunks.push(...chunks);
  }

  async share(): Promise<void> {
    this.shared = true;
  }

  discard(): void {
    this.chunks = [];
  }

  bytes(): Uint8Array {
    const bytes = new Uint8Array(this.chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
}

describe("exporting every activity (IO-005)", () => {
  it("writes one masked file per readable track and skips the missing ones", async () => {
    const first = await imported(gpxOf({ seconds: 600 }));
    const second = await imported(gpxOf({ seconds: 300, offsetMs: 86_400_000 }));
    const gone = await imported(gpxOf({ seconds: 300, offsetMs: 2 * 86_400_000 }));
    const goneFile = db().select({ trackFile: recording.trackFile }).from(recording).where(eq(recording.sessionId, gone)).get()?.trackFile;
    if (goneFile == null) throw new Error("No track");
    storedFiles.delete(new File(Paths.document, goneFile).uri);
    db().update(settings).set({ hideTrackEndsMeters: 200 }).run();
    const rows = exportableSessions(db(), null);
    expect(rows.map((row) => row.sessionId)).toEqual([first, second, gone]);
    const file = new MemoryFile();
    const progress: number[] = [];
    expect(await writeArchive(rows, "fit", false, file, (done) => progress.push(done))).toEqual({ exported: 2, skipped: 1 });
    expect(progress).toEqual([1, 2, 3]);
    const entries = unzipSync(file.bytes());
    expect(Object.keys(entries)).toEqual(["obnixe-2026-10-01-footing.fit", "obnixe-2026-10-02-footing.fit"]);
    const firstBack = readActivityFile(entries["obnixe-2026-10-01-footing.fit"] ?? new Uint8Array());
    expect(firstBack.startedAt).toBe(startedAt);
    expect(firstBack.points.length).toBeLessThan(600 - 100);
  });

  it("starts the periods on the right local date", () => {
    const today = "2026-11-27" as LocalDate;
    expect(archivePeriods.map((period) => periodStart(period, today))).toEqual([null, "2026-01-01", "2025-11-28", "2026-10-29"]);
  });

  it("streams the archive into the export folder", async () => {
    const file = createStreamedFile("obnixe-activites-2026-11-27.zip", "application/zip");
    await file.write([new Uint8Array([1, 2]), new Uint8Array([3])]);
    await file.write([new Uint8Array([4])]);
    await file.share();
    expect(storedFiles.get("file:///data/cache/exports/obnixe-activites-2026-11-27.zip")).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(shareAsync).toHaveBeenCalledWith("file:///data/cache/exports/obnixe-activites-2026-11-27.zip", { mimeType: "application/zip", dialogTitle: "obnixe-activites-2026-11-27.zip" });
    file.discard();
    expect(storedFiles.has("file:///data/cache/exports/obnixe-activites-2026-11-27.zip")).toBe(false);
  });
});

describe("opened files", () => {
  const matches: readonly { readonly path: string; readonly route: string | null }[] = [
    { path: "content://com.android.providers.downloads/document/42", route: "/import-activity?file=content%3A%2F%2Fcom.android.providers.downloads%2Fdocument%2F42" },
    { path: "file:///var/mobile/Documents/Inbox/run.fit", route: "/import-activity?file=file%3A%2F%2F%2Fvar%2Fmobile%2FDocuments%2FInbox%2Frun.fit" },
    { path: "obnixe://pair?code=1", route: null },
    { path: "/session/abc", route: null },
  ];

  it("routes shared and opened files to the import screen (IO-051)", () => {
    for (const { path, route } of matches) expect(openedFileRoute(path)).toBe(route);
  });
});

describe("resolutions", () => {
  const samples: readonly ImportMatch[] = [
    { kind: "new" },
    { kind: "already_imported", sessionId: "s" as Id },
    { kind: "probable", sessionIds: ["s" as Id] },
    { kind: "merge", merge: { sessionId: "s" as Id, trackFile: "tracks/s.otrk", addsHeartRate: true, offersAltitude: false } },
  ];

  it("import nothing by default for a duplicate, and merge a phone recording (IO-012, IO-052)", () => {
    expect(samples.map(defaultResolution)).toEqual(["keep", "ignore", "ignore", "merge"]);
    expect(decisionOf(samples[3] ?? { kind: "new" }, "merge", null, true)).toEqual({ kind: "merge", merge: { sessionId: "s", trackFile: "tracks/s.otrk", addsHeartRate: true, offersAltitude: false }, replaceAltitude: false });
    expect(decisionOf({ kind: "new" }, "replace", null, false)).toBeNull();
  });
});
