import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { route, session } from "@obnixe/schema";
import type { EpochMs, LocalDate } from "@obnixe/schema";
import { fixtures } from "../../data/testFixtures.ts";
import type { Fixtures } from "../../data/testFixtures.ts";
import { trashMutation } from "../../data/trash.ts";
import { createTestContext } from "../../testing.ts";
import type { TestContext } from "../../testing.ts";
import { commit } from "../../writer.ts";
import { activityRoute, newRoute } from "../routes.ts";
import { untrimmed } from "../testing/run.ts";
import { archiveFileName, ExportArchive, exportableSessions } from "./bulkExport.ts";
import { exportActivity, exportFileName } from "./export.ts";
import type { ExportFormat } from "./export.ts";
import { computeImport, planImport } from "./import.ts";
import type { ImportComputation, ImportPlan } from "./import.ts";
import { readActivityFile } from "./zip.ts";

const fixtureDirectory = new URL("../../../test/fixtures/import/", import.meta.url);

function computed(name: string): ImportComputation {
  const activity = readActivityFile(new Uint8Array(readFileSync(new URL(name, fixtureDirectory))));
  if (activity.sport === null) throw new Error(`${name} has no sport`);
  return computeImport(activity, activity.sport);
}

let context: TestContext;
let make: Fixtures;

beforeEach(() => {
  context = createTestContext();
  make = fixtures(context);
});

function imported(computation: ImportComputation): ImportPlan {
  const plan = planImport(context.db, context.env, { computation, timeZone: "Europe/Paris", replaceSessionId: null });
  commit(context.db, context.env, plan.request);
  return plan;
}

function concatenated(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

describe("exportable sessions (IO-005)", () => {
  it("lists the live sessions with a track, oldest first, from a local date", () => {
    const run = imported(computed("venu3s-run.fit"));
    const earlier = imported(computed("garmin-connect-run.gpx"));
    const trashed = imported(computed("strava-ride.gpx"));
    make.write([trashMutation("session", trashed.sessionId, context.env.now())]);
    expect(exportableSessions(context.db, null).map((row) => row.sessionId)).toEqual([earlier.sessionId, run.sessionId]);
    const runDate = context.db.select({ localDate: session.localDate }).from(session).where(eq(session.id, run.sessionId)).get()?.localDate;
    if (runDate === undefined) throw new Error("No run");
    expect(exportableSessions(context.db, runDate).map((row) => row.sessionId)).toEqual([run.sessionId]);
    expect(exportableSessions(context.db, "2099-01-01" as LocalDate)).toEqual([]);
  });

  it("leaves the routes out, even one drawn from an exported activity", () => {
    const computation = computed("venu3s-run.fit");
    const run = imported(computation);
    if (computation.processed === null) throw new Error("No processed track");
    make.write([newRoute(context.env, { name: "Boucle", sport: "run", ...activityRoute(computation.processed), sourceSessionId: run.sessionId }).mutation]);
    expect(context.db.select().from(route).all()).toHaveLength(1);
    expect(exportableSessions(context.db, null).map((row) => row.sessionId)).toEqual([run.sessionId]);
  });
});

describe("export archive (IO-005)", () => {
  it.each(["gpx", "fit"] as const)("streams %s files that read back through the import", (format: ExportFormat) => {
    const archive = new ExportArchive();
    const chunks: Uint8Array[] = [];
    const sources = [computed("venu3s-run.fit"), computed("garmin-connect-run.gpx"), computed("venu3s-run.fit")];
    const names = sources.map((computation) => {
      const name = exportFileName({ startedAt: computation.activity.startedAt, timeZone: "UTC", title: null, sport: computation.sport.sport }, format);
      const bytes = exportActivity({ track: computation.track, processed: computation.processed, trim: untrimmed, sport: computation.sport.sport, values: computation.sport.values, title: null, mask: null, energyKcal: null }, format);
      const added = archive.add(name, bytes, computation.activity.startedAt);
      chunks.push(...archive.take());
      return added;
    });
    expect(names).toEqual([`obnixe-2026-11-20-course.${format}`, `obnixe-2026-11-02-course.${format}`, `obnixe-2026-11-20-course-2.${format}`]);
    archive.end();
    chunks.push(...archive.take());
    expect(archive.take()).toEqual([]);
    const entries = unzipSync(concatenated(chunks));
    expect(Object.keys(entries)).toEqual(names);
    names.forEach((name, index) => {
      const back = readActivityFile(entries[name] ?? new Uint8Array());
      expect(back.format).toBe(format);
      expect(back.startedAt).toBe(sources[index]?.activity.startedAt);
      expect(back.points.length).toBe(sources[index]?.processed?.series.length);
    });
  });

  it("names the archive after the export date and accepts a start outside the ZIP dates", () => {
    expect(archiveFileName("2026-11-27" as LocalDate)).toBe("obnixe-activites-2026-11-27.zip");
    const archive = new ExportArchive();
    expect(archive.add("notes", new Uint8Array([1]), 0 as EpochMs)).toBe("notes");
    archive.end();
    expect(Object.keys(unzipSync(concatenated(archive.take())))).toEqual(["notes"]);
  });
});
