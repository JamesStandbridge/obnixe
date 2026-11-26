import { readFileSync } from "node:fs";
import { eq, isNull } from "drizzle-orm";
import { zipSync } from "fflate";
import type { Zippable } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeset, recording, session } from "@obnixe/schema";
import type { Id } from "@obnixe/schema";
import { fixtures } from "../../data/testFixtures.ts";
import { createTestContext } from "../../testing.ts";
import type { TestContext } from "../../testing.ts";
import { RevertConflictError } from "../../undo.ts";
import { commit } from "../../writer.ts";
import { archiveBatchSize, ArchiveStoppedError, importArchive, previewArchive, slicedPace, undoArchiveImport } from "./archive.ts";
import type { ArchiveControl, ArchiveDuplicatePolicy, ArchiveImportHost, ArchiveImportReport, ArchivePreview, OpenedArchive, ScratchSpace } from "./archive.ts";
import { openGarminArchive } from "./garminArchive.ts";
import { computeImport, planImport } from "./import.ts";
import { readActivityFile } from "./zip.ts";
import { ArchiveError } from "./zipArchive.ts";
import type { ArchiveSource } from "./zipArchive.ts";

const fixtureDirectory = new URL("../../../test/fixtures/import/", import.meta.url);
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, fixtureDirectory)));
const encoder = new TextEncoder();
const uploaded = "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip";
const metersPerDegree = 111_195;

const run = fixture("venu3s-run.fit");
const swim = fixture("venu3s-pool-swim.fit");
const runStart = readActivityFile(run).startedAt;
const swimStart = readActivityFile(swim).startedAt;

function memory(bytes: Uint8Array): ArchiveSource {
  return { size: bytes.length, read: async (offset, length) => bytes.slice(offset, offset + length) };
}

/** A run north at 3 m/s, one point per second; `creator` makes files of the same outing differ. */
function runGpx(startedAt: number, seconds: number, creator: string): Uint8Array {
  const points = Array.from(
    { length: seconds },
    (_, index) => `<trkpt lat="${(45.1885 + (index * 3) / metersPerDegree).toFixed(7)}" lon="5.7245000"><ele>250</ele><time>${new Date(startedAt + index * 1000).toISOString()}</time></trkpt>`,
  );
  return encoder.encode(`<?xml version="1.0"?><gpx version="1.1" creator="${creator}" xmlns="http://www.topografix.com/GPX/1/1"><trk><type>running</type><trkseg>${points.join("")}</trkseg></trk></gpx>`);
}

interface Summary {
  readonly activityId: number;
  readonly name?: string;
  readonly beginTimestamp?: number;
  readonly startTimeGmt?: number;
}

interface ExportShape {
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly summaries?: readonly Summary[];
  /** Compression level of the nested `UploadedFiles` archive: 0 keeps it stored. */
  readonly level?: 0 | 6;
  readonly extra?: Zippable;
}

function garminExport({ files, summaries = [], level = 6, extra = {} }: ExportShape): Uint8Array {
  const inner = zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [`user@example.com_${name}`, bytes])));
  return zipSync({
    "DI_CONNECT/DI-Connect-Fitness/user@example.com_0_summarizedActivities.json": encoder.encode(JSON.stringify([{ summarizedActivitiesExport: summaries.map((summary) => ({ activityType: "running", ...summary })) }])),
    [uploaded]: [inner, { level }],
    "DI_CONNECT/DI-Connect-Wellness/2026-01-01_2026-12-31_sleepData.json": encoder.encode("[]"),
    ...extra,
  });
}

const mainExport = (): Uint8Array =>
  garminExport({
    files: {
      "101.fit": run,
      "102.fit": swim,
      "103.fit": fixture("malformed/course.fit"),
      "104.tcx": fixture("garmin-run.tcx"),
      "105.gpx": fixture("komoot-hike.gpx"),
      "106.fit": fixture("malformed/bad-crc.fit"),
    },
    summaries: [
      { activityId: 9001, name: "Footing du matin", beginTimestamp: runStart + 400, startTimeGmt: runStart },
      { activityId: 9002, name: "Natation", startTimeGmt: swimStart - 1000 },
      { activityId: 9003, name: "Sans fichier", startTimeGmt: runStart - 86_400_000 },
    ],
  });

let context: TestContext;

function freshContext(): TestContext {
  const created = createTestContext();
  fixtures(created);
  return created;
}

let liveScratch: number;
let tracks: Map<string, Uint8Array>;

const scratch: ScratchSpace = async () => {
  const chunks: Uint8Array[] = [];
  liveScratch += 1;
  return {
    append: async (bytes) => void chunks.push(bytes.slice()),
    finish: async () => {
      const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      chunks.reduce((offset, chunk) => (joined.set(chunk, offset), offset + chunk.length), 0);
      return memory(joined);
    },
    discard: async () => void (liveScratch -= 1),
  };
};

function control(overrides: Partial<ArchiveControl> = {}): ArchiveControl {
  return { pace: async () => undefined, stopped: () => false, onProgress: () => undefined, ...overrides };
}

function host(overrides: Partial<ArchiveImportHost> = {}): ArchiveImportHost {
  return {
    ...control(),
    db: context.db,
    env: context.env,
    writeTrack: async (recordingId, track) => {
      expect(context.db.select().from(recording).where(eq(recording.id, recordingId)).get()).toBeUndefined();
      tracks.set(track.path, track.bytes);
    },
    ...overrides,
  };
}

const opened = (bytes: Uint8Array): Promise<OpenedArchive> => openGarminArchive(memory(bytes), scratch, control());
const previewed = (archive: OpenedArchive): Promise<ArchivePreview> => previewArchive(context.db, archive, control());

async function imported(bytes: Uint8Array, duplicates: ArchiveDuplicatePolicy = "ignore", overrides: Partial<ArchiveImportHost> = {}): Promise<ArchiveImportReport> {
  const archive = await opened(bytes);
  const preview = await previewed(archive);
  const report = await importArchive(archive, { preview, duplicates, timeZone: "Europe/Paris" }, host(overrides));
  await archive.close();
  return report;
}

function importSingle(bytes: Uint8Array): Id {
  const activity = readActivityFile(bytes);
  const plan = planImport(context.db, context.env, { computation: computeImport(activity, activity.sport ?? { sport: "run", values: {} }), timeZone: "Europe/Paris", replaceSessionId: null });
  commit(context.db, context.env, plan.request);
  return plan.sessionId;
}

const liveRecordings = () =>
  context.db
    .select({ sessionId: session.id, title: session.title, sport: session.sport, externalId: recording.externalId, importFormat: recording.importFormat, trackFile: recording.trackFile })
    .from(recording)
    .innerJoin(session, eq(session.id, recording.sessionId))
    .where(isNull(session.deletedAt))
    .all();

async function archiveRefusal(task: Promise<unknown>): Promise<string> {
  try {
    await task;
  } catch (error) {
    if (error instanceof ArchiveError) return error.reason;
    throw error;
  }
  throw new Error("expected an ArchiveError");
}

beforeEach(() => {
  context = freshContext();
  liveScratch = 0;
  tracks = new Map();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openGarminArchive (IO-053)", () => {
  it("lists the files of a compressed nested archive from a scratch file, discarded on close", async () => {
    const progress: number[] = [];
    const archive = await openGarminArchive(memory(mainExport()), scratch, control({ onProgress: ({ done }) => progress.push(done) }));
    expect(liveScratch).toBe(1);
    expect(archive.files.map((file) => file.path.slice(uploaded.length + 1))).toEqual(["101.fit", "102.fit", "103.fit", "104.tcx", "105.gpx", "106.fit"].map((name) => `user@example.com_${name}`));
    expect(progress.length).toBeGreaterThan(0);
    await archive.close();
    expect(liveScratch).toBe(0);
  });

  it("reads a stored nested archive in place, loose files and the older folder name, and refuses an unreadable nested archive alone", async () => {
    const bytes = garminExport({
      files: { "101.fit": run },
      level: 0,
      extra: {
        "DI_CONNECT/DI-Connect-Uploaded-Files/loose_201.tcx": fixture("garmin-run.tcx"),
        "DI_CONNECT/DI-Connect-Fitness-Uploaded-Files/UploadedFiles_1-_Part1.zip": zipSync({ "user@example.com_301.fit": swim }),
        "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part2.zip": [encoder.encode("not a zip, cut during the download"), { level: 0 }],
      },
    });
    const archive = await opened(bytes);
    expect(liveScratch).toBe(1);
    expect(archive.files.map((file) => file.path)).toEqual([
      "DI_CONNECT/DI-Connect-Uploaded-Files/loose_201.tcx",
      `${uploaded}/user@example.com_101.fit`,
      "DI_CONNECT/DI-Connect-Fitness-Uploaded-Files/UploadedFiles_1-_Part1.zip/user@example.com_301.fit",
    ]);
    expect(archive.refused).toEqual([{ path: "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part2.zip", reason: "not_a_zip" }]);
    expect((await previewed(archive)).importable).toBe(3);
    await archive.close();
  });

  it("refuses a ZIP that is not a Garmin Connect export, and unreadable summaries", async () => {
    expect(await archiveRefusal(opened(zipSync({ "activity.fit": run })))).toBe("not_an_account_archive");
    expect(await archiveRefusal(opened(encoder.encode("plain text, long enough to look for a ZIP end record")))).toBe("not_a_zip");
    const garbled: Zippable = { "DI_CONNECT/DI-Connect-Fitness/user_0_summarizedActivities.json": encoder.encode("{ not json") };
    expect(await archiveRefusal(opened(garminExport({ files: { "101.fit": run }, extra: garbled })))).toBe("malformed");
  });

  it("stops while inflating and discards the scratch files", async () => {
    let paced = 0;
    const task = openGarminArchive(memory(mainExport()), scratch, control({ pace: async () => void (paced += 1), stopped: () => paced > 0 }));
    await expect(task).rejects.toBeInstanceOf(ArchiveStoppedError);
    expect(liveScratch).toBe(0);
  });
});

describe("previewArchive (IO-020, IO-024)", () => {
  it("counts activities per sport, the period, unsupported sports and refused files, and skips other files", async () => {
    const archive = await opened(mainExport());
    const progress: number[] = [];
    const preview = await previewArchive(context.db, archive, control({ onProgress: ({ done, total }) => progress.push(done / total) }));
    expect(preview).toEqual({
      sports: [
        { sport: "run", count: 2 },
        { sport: "swim", count: 1 },
      ],
      importable: 3,
      duplicates: 0,
      firstStartedAt: readActivityFile(fixture("garmin-run.tcx")).startedAt,
      lastStartedAt: swimStart,
      alreadyImported: 0,
      unsupported: 1,
      refused: [{ path: `${uploaded}/user@example.com_106.fit`, reason: "checksum" }],
      candidates: [0, 1, 3],
    });
    expect(progress.at(-1)).toBe(1);
    expect(liveRecordings()).toEqual([]);
    await archive.close();
  });

  it("counts a FIT already imported from the watch as already imported, whatever its archive identity", async () => {
    importSingle(run);
    const preview = await previewed(await opened(mainExport()));
    expect(preview).toMatchObject({ importable: 2, alreadyImported: 1, candidates: [1, 3] });
  });
});

describe("importArchive (IO-053, IO-024, IO-025)", () => {
  it("imports with the archive identity, the Garmin title and import_format garmin_archive, tracks written before the commit", async () => {
    const report = await imported(mainExport());
    expect(report).toMatchObject({ format: "garmin_archive", imported: 3, replaced: 0, skipped: 0, stopped: false, refused: [{ path: `${uploaded}/user@example.com_106.fit`, reason: "checksum" }] });
    expect(report.batches).toHaveLength(1);
    const rows = liveRecordings();
    expect(rows.map((row) => [row.externalId, row.title, row.sport, row.importFormat]).sort()).toEqual(
      [
        ["garmin:9001", "Footing du matin", "run", "garmin_archive"],
        ["garmin:9002", "Natation", "swim", "garmin_archive"],
        [readActivityFile(fixture("garmin-run.tcx")).externalId, readActivityFile(fixture("garmin-run.tcx")).name, "run", "garmin_archive"],
      ].sort(),
    );
    for (const row of rows.filter((candidate) => candidate.trackFile !== null)) expect(tracks.has(row.trackFile ?? "")).toBe(true);
    expect(report.batches[0]?.trackFiles.length).toBe(tracks.size);
    const written = context.db.select({ author: changeset.author, summary: changeset.summary }).from(changeset).where(eq(changeset.id, report.batches[0]?.changesetId ?? ("" as Id))).get();
    expect(written).toEqual({ author: "import", summary: "Import de l'archive Garmin Connect" });
  });

  it("adds nothing when the same archive comes again, and only the new activities from a newer archive (IO-024)", async () => {
    await imported(mainExport());
    const again = await imported(mainExport());
    expect(again).toMatchObject({ imported: 0, batches: [] });
    expect((await previewed(await opened(mainExport()))).alreadyImported).toBe(3);
    const newer = garminExport({ files: { "101.fit": run, "102.fit": swim, "107.fit": fixture("venu3s-treadmill.fit") }, summaries: [{ activityId: 9001, startTimeGmt: runStart }, { activityId: 9002, startTimeGmt: swimStart }] });
    const report = await imported(newer);
    expect(report).toMatchObject({ imported: 1, skipped: 0 });
    expect(liveRecordings()).toHaveLength(4);
  });

  it("commits batches of archiveBatchSize activities and reports progress, pacing after every file", async () => {
    const day = 86_400_000;
    const start = Date.UTC(2026, 3, 1, 7);
    const files = Object.fromEntries(Array.from({ length: archiveBatchSize + 5 }, (_, index) => [`${500 + index}.gpx`, runGpx(start + index * day, 120, "watch")]));
    const summaries = Array.from({ length: archiveBatchSize + 5 }, (_, index): Summary => ({ activityId: 7000 + index, name: `Sortie ${index}`, startTimeGmt: start + index * day }));
    let paced = 0;
    const progress: number[] = [];
    const report = await imported(garminExport({ files, summaries }), "ignore", { pace: async () => void (paced += 1), onProgress: ({ done }) => progress.push(done) });
    expect(report.imported).toBe(archiveBatchSize + 5);
    expect(report.batches.map((batch) => batch.sessionIds.length)).toEqual([archiveBatchSize, 5]);
    expect(paced).toBe(archiveBatchSize + 5);
    expect(progress.at(-1)).toBe(archiveBatchSize + 5);
    expect(new Set(liveRecordings().map((row) => row.externalId))).toEqual(new Set(summaries.map((summary) => `garmin:${summary.activityId}`)));
  });

  it("stops between activities and keeps what was imported", async () => {
    const start = Date.UTC(2026, 3, 1, 7);
    const files = Object.fromEntries(Array.from({ length: archiveBatchSize + 5 }, (_, index) => [`${500 + index}.gpx`, runGpx(start + index * 86_400_000, 60, "watch")]));
    let done = 0;
    const report = await imported(garminExport({ files }), "ignore", { onProgress: (progress) => void (done = progress.done), stopped: () => done >= archiveBatchSize + 2 });
    expect(report).toMatchObject({ stopped: true, imported: archiveBatchSize + 2 });
    expect(report.batches.map((batch) => batch.sessionIds.length)).toEqual([archiveBatchSize, 2]);
    expect(liveRecordings()).toHaveLength(archiveBatchSize + 2);
  });
});

describe("archive duplicates (IO-012)", () => {
  const start = Date.UTC(2026, 5, 14, 6, 30);
  const watchExport = (): Uint8Array => garminExport({ files: { "401.gpx": runGpx(start + 30_000, 1200, "watch") }, summaries: [{ activityId: 4401, name: "Sortie longue", startTimeGmt: start + 30_000 }] });

  it("flags a session of the same sport within 120 s and 5 % as a duplicate, ignored by default", async () => {
    importSingle(runGpx(start, 1200, "phone"));
    expect((await previewed(await opened(watchExport()))).duplicates).toBe(1);
    const report = await imported(watchExport());
    expect(report).toMatchObject({ imported: 0, skipped: 1 });
    expect(liveRecordings()).toHaveLength(1);
  });

  it("keeps both, or replaces the session, then undoes the replacement", async () => {
    const phone = importSingle(runGpx(start, 1200, "phone"));
    await imported(watchExport(), "keep");
    expect(liveRecordings()).toHaveLength(2);
    context = freshContext();
    const phoneAgain = importSingle(runGpx(start, 1200, "phone"));
    const report = await imported(watchExport(), "replace");
    expect(report).toMatchObject({ imported: 1, replaced: 1 });
    expect(liveRecordings().map((row) => row.externalId)).toEqual(["garmin:4401"]);
    const files = undoArchiveImport(context.db, context.env, report, { actor: { author: "user", connectionId: null }, summary: "Annulation", restoredVersionSummary: (number) => `v${number}` });
    expect(files).toEqual(report.batches.flatMap((batch) => batch.trackFiles));
    expect(liveRecordings().map((row) => row.sessionId)).toEqual([phoneAgain]);
    expect(phone).not.toBe(phoneAgain);
  });

  it("never imports an outing twice from the same archive unless asked to keep both", async () => {
    const twins = garminExport({ files: { "401.gpx": runGpx(start, 1200, "watch"), "402.gpx": runGpx(start + 20_000, 1200, "phone app") } });
    expect((await previewed(await opened(twins))).duplicates).toBe(1);
    expect((await imported(twins, "replace")).imported).toBe(1);
    context = freshContext();
    expect((await imported(twins, "keep")).imported).toBe(2);
  });
});

describe("undoArchiveImport (IO-025)", () => {
  it("reverts every batch newest first and returns the tracks to delete", async () => {
    const start = Date.UTC(2026, 3, 1, 7);
    const files = Object.fromEntries(Array.from({ length: archiveBatchSize + 3 }, (_, index) => [`${500 + index}.gpx`, runGpx(start + index * 86_400_000, 60, "watch")]));
    const report = await imported(garminExport({ files }));
    expect(report.batches).toHaveLength(2);
    const removed = undoArchiveImport(context.db, context.env, report, { actor: { author: "user", connectionId: null }, summary: "Annulation", restoredVersionSummary: (number) => `v${number}` });
    expect(removed).toHaveLength(archiveBatchSize + 3);
    expect(liveRecordings()).toEqual([]);
    expect(context.db.select().from(session).all()).toEqual([]);
  });

  it("undoes nothing when an imported activity was edited since", async () => {
    const report = await imported(mainExport());
    const edited = liveRecordings()[0]?.sessionId ?? ("" as Id);
    commit(context.db, context.env, { actor: { author: "user", connectionId: null }, summary: "Titre", revertsId: null, mutations: [{ kind: "update", table: "session", key: edited, patch: { title: "Renommée" } }] });
    expect(() => undoArchiveImport(context.db, context.env, report, { actor: { author: "user", connectionId: null }, summary: "Annulation", restoredVersionSummary: (number) => `v${number}` })).toThrow(RevertConflictError);
    expect(liveRecordings()).toHaveLength(3);
  });
});

describe("slicedPace (IO-026)", () => {
  it("yields to the event loop only once the slice budget is spent", async () => {
    let clock = 0;
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    const pace = slicedPace(() => clock, 8);
    clock = 5;
    await pace();
    expect(timeouts).not.toHaveBeenCalled();
    clock = 9;
    await pace();
    expect(timeouts).toHaveBeenCalledTimes(1);
    clock = 12;
    await pace();
    expect(timeouts).toHaveBeenCalledTimes(1);
  });
});