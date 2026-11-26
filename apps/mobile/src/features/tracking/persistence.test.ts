import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  activePrivacyMask,
  commit,
  computeImport,
  decodeTrack,
  encodeJournalBatch,
  encodeJournalHeader,
  encodeTrack,
  locate,
  newSegment,
  planImport,
  planRecordingSave,
  planRecordingStart,
  processTrack,
  profileOfSession,
  readActivityFile,
  recordingStartMutations,
  staleDerivationCount,
  staleSegments,
  trackDigest,
  trashMutation,
  zoneProposalFor,
} from "@obnixe/core";
import type { Fix, JournalRecord, Mutation } from "@obnixe/core";
import { bestEffort, recording, recordingDerivation, segmentEffort, session, settings } from "@obnixe/schema";
import type { EpochMs, Id } from "@obnixe/schema";
import { DerivedRebuild } from "@/features/tracking/derivedRebuild";
import { journalTrackOf } from "@/features/tracking/journalFeed";
import { reconcileRecordingFiles } from "@/features/tracking/launchReconciliation";
import { journalSessionIds, journalUri, readTrackFile, storedTrackFiles, writeTrack } from "@/features/tracking/trackStore";
import { settleZoneProposal, zoneFromProposal } from "@/features/tracking/zoneProposals";
import { db, environment } from "../../../test/mocks/database.ts";
import { Paths, storedFiles } from "../../../test/mocks/expoFileSystem.ts";

const metersPerE7 = 111_195 / 1e7;
const home = { latitudeE7: 451_885_000, longitudeE7: 57_245_000 };

function fixAt(t: number, meters: number): Fix {
  return {
    type: "fix",
    t,
    fixAgeMs: 0,
    latitudeE7: home.latitudeE7 + Math.round(meters / metersPerE7),
    longitudeE7: home.longitudeE7,
    altitudeEllipsoidMm: 250_000,
    altitudeMslMm: null,
    horizontalAccuracyDm: 40,
    verticalAccuracyDm: null,
    speedCmS: 300,
    speedAccuracyCmS: 50,
    bearingCentiDeg: 0,
    bearingAccuracyCentiDeg: null,
    simulated: false,
  };
}

const write = (summary: string, mutations: readonly Mutation[]): Id => commit(db(), environment, { actor: { author: "user", connectionId: null }, summary, revertsId: null, mutations });
const writer = { write };

interface Recorded {
  readonly sessionId: Id;
  readonly recordingId: Id;
  readonly journal: Uint8Array;
}

/** A finished recording as the native module journals it: 3 m/s north from home for `seconds`. */
function journalOf(sessionId: Id, startedAt: EpochMs, seconds: number): Uint8Array {
  const fixes: JournalRecord[] = Array.from({ length: seconds }, (_, index) => fixAt((index + 1) * 1000, (index + 1) * 3));
  const parts = [
    encodeJournalHeader({ sessionId, startedAt, monotonicOriginNs: 0n, platform: "android", device: "Pixel 9 Pro" }),
    encodeJournalBatch(0, [{ type: "mark", kind: "start", t: 0 }]),
    encodeJournalBatch(1, [...fixes, { type: "mark", kind: "stop", t: seconds * 1000 }]),
  ];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

async function recorded(seconds: number, saved: boolean): Promise<Recorded> {
  const plan = planRecordingStart(db(), environment, { sport: "run", values: {}, gearId: null, slot: null, timeZone: "Europe/Paris", routeId: null, workout: null, stopwatch: false });
  const startedAt = (environment.now() - (seconds + 60) * 1000) as EpochMs;
  const journal = journalOf(plan.sessionId, startedAt, seconds);
  storedFiles.set(journalUri(plan.sessionId), journal);
  write("Sortie démarrée", recordingStartMutations(plan, { startedAt, device: "Pixel 9 Pro" }));
  if (saved) {
    const { track } = journalTrackOf(journal, startedAt);
    const processed = processTrack(track, plan.profile, { laps: { kind: "recorded", autoLap: null }, trim: { startMs: 0, endMs: null } });
    const stored = await writeTrack(plan.recordingId, encodeTrack(track));
    write("Sortie", planRecordingSave(db(), environment, { sessionId: plan.sessionId, track, processed, stored, pains: [] }));
  }
  return { sessionId: plan.sessionId, recordingId: plan.recordingId, journal };
}

const recordingRow = (sessionId: Id) => db().select().from(recording).where(eq(recording.sessionId, sessionId)).get();

beforeEach(() => {
  db()
    .insert(settings)
    .values({ singleton: 1, theme: "dark", massUnit: "kg", agentCanReadBody: false, agentCanWrite: false, agentCanReadPhotos: false, reminderWeekdays: 0, reminderMinutes: 1110, remindersExportedAt: null, agentChangesSeenAt: null, bridgeHost: null, updatedAt: environment.now() })
    .run();
});

describe("launch reconciliation", () => {
  it("deletes orphan journals and the journals of verified tracks, and keeps the open session's (annex C)", async () => {
    const saved = await recorded(120, true);
    const orphan = "0190a3f2-7c4e-7d21-9b1a-5f2e8c3d4a99" as Id;
    storedFiles.set(journalUri(orphan), new Uint8Array([1]));
    const open = await recorded(60, false);
    const report = await reconcileRecordingFiles(writer);
    expect(report).toEqual({ deletedJournals: 2, rebuiltTracks: 0, deletedTracks: 0 });
    expect(await journalSessionIds()).toEqual([open.sessionId]);
    expect(readTrackFile(`tracks/${saved.recordingId}.otrk`)).not.toBeNull();
  });

  it("rebuilds a lost track from the journal in « Trace reconstruite » (REC-082)", async () => {
    const saved = await recorded(120, true);
    const before = recordingRow(saved.sessionId);
    storedFiles.delete(`${Paths.document.uri}/${before?.trackFile ?? ""}`);
    const report = await reconcileRecordingFiles(writer);
    expect(report.rebuiltTracks).toBe(1);
    const after = recordingRow(saved.sessionId);
    const bytes = readTrackFile(after?.trackFile ?? "");
    expect(bytes).not.toBeNull();
    expect(trackDigest(bytes ?? new Uint8Array())).toBe(after?.trackSha256);
    expect(await journalSessionIds()).toEqual([]);
  });

  it("sweeps temporary and unreferenced track files but keeps those of trashed sessions (INT-031)", async () => {
    const trashed = await recorded(60, true);
    write("Corbeille", [trashMutation("session", trashed.sessionId, environment.now())]);
    storedFiles.set(`${Paths.document.uri}/tracks/stray.otrk`, new Uint8Array([1]));
    storedFiles.set(`${Paths.document.uri}/tracks/${trashed.recordingId}.otrk.tmp`, new Uint8Array([1]));
    const report = await reconcileRecordingFiles(writer);
    expect(report.deletedTracks).toBe(1);
    expect(await storedTrackFiles()).toEqual([`tracks/${trashed.recordingId}.otrk`]);
    expect([...storedFiles.keys()].some((uri) => uri.endsWith(".tmp"))).toBe(false);
  });
});

describe("derived rows", () => {
  it("rebuilds the records and the masked previews in the background until nothing is stale (DAT-012)", async () => {
    const run = await recorded(200, true);
    const rebuild = new DerivedRebuild(writer, (error) => {
      throw error;
    });
    await rebuild.request();
    expect(rebuild.getState()).toEqual({ pending: 0, segments: 0, running: false });
    expect(db().select().from(bestEffort).where(eq(bestEffort.sessionId, run.sessionId)).all().map((row) => row.effort)).toContain("run:distance:400");
    const plain = recordingRow(run.sessionId)?.previewPolyline;
    write("Zone", [{ kind: "insert", table: "privacy_zone", row: { id: environment.newId(), label: "Maison", ...home, radiusMeters: 200, maskScalePermille: 1000, deletedAt: null } }]);
    expect(staleDerivationCount(db(), activePrivacyMask(db()))).toBe(1);
    await rebuild.request();
    expect(staleDerivationCount(db(), activePrivacyMask(db()))).toBe(0);
    expect(recordingRow(run.sessionId)?.previewPolyline).not.toBe(plain);
  });

  it("searches a new segment over every recording that may pass it (SEG-003)", async () => {
    const first = await recorded(200, true);
    const second = await recorded(200, true);
    const rebuild = new DerivedRebuild(writer, (error) => {
      throw error;
    });
    await rebuild.request();
    const live = db().select({ session, recording }).from(recording).innerJoin(session, eq(session.id, recording.sessionId)).where(eq(recording.sessionId, first.sessionId)).get();
    const processed = processTrack(decodeTrack(readTrackFile(live?.recording.trackFile ?? "") ?? new Uint8Array()), profileOfSession(live?.session ?? { id: first.sessionId, sport: "run", values: {} }), {
      laps: { kind: "recorded", autoLap: null },
      trim: { startMs: 0, endMs: null },
    });
    const range = { from: locate(processed.series.distance, 100), to: locate(processed.series.distance, 400) };
    const plan = newSegment(environment, processed.series, false, { name: "Avenue", sport: "run", sessionId: first.sessionId, range });
    write("Segment créé", [plan.mutation]);
    expect(staleSegments(db())).toHaveLength(1);
    await rebuild.request();
    expect(rebuild.getState()).toEqual({ pending: 0, segments: 0, running: false });
    expect(staleSegments(db())).toEqual([]);
    const efforts = db().select().from(segmentEffort).where(eq(segmentEffort.segmentId, plan.segmentId)).all();
    expect(efforts.map((effort) => effort.sessionId).sort()).toEqual([first.sessionId, second.sessionId].sort());
  });

  it("defers its passes while held, such as during an archive import, then derives everything in one pass (IO-026)", async () => {
    const run = await recorded(200, true);
    const rebuild = new DerivedRebuild(writer, (error) => {
      throw error;
    });
    const release = rebuild.hold();
    await rebuild.request();
    expect(staleDerivationCount(db(), activePrivacyMask(db()))).toBe(1);
    release();
    release();
    await rebuild.request();
    expect(staleDerivationCount(db(), activePrivacyMask(db()))).toBe(0);
    expect(db().select().from(bestEffort).where(eq(bestEffort.sessionId, run.sessionId)).all()).not.toEqual([]);
  });

  it("stops a running pass at its next batch when held", async () => {
    for (let index = 0; index < 21; index += 1) await recorded(30, true);
    const rebuild = new DerivedRebuild(writer, (error) => {
      throw error;
    });
    const pass = rebuild.request();
    const release = rebuild.hold();
    await pass;
    expect(staleDerivationCount(db(), activePrivacyMask(db()))).toBe(1);
    expect(rebuild.getState().running).toBe(false);
    release();
    await rebuild.request();
    expect(staleDerivationCount(db(), activePrivacyMask(db()))).toBe(0);
  });

  it("skips a recording whose track is gone instead of looping", async () => {
    const run = await recorded(60, true);
    storedFiles.delete(`${Paths.document.uri}/tracks/${run.recordingId}.otrk`);
    const rebuild = new DerivedRebuild(writer, (error) => {
      throw error;
    });
    await rebuild.request();
    expect(db().select().from(recordingDerivation).all()).toEqual([]);
    expect(rebuild.getState().running).toBe(false);
  });
});

describe("imported tracks", () => {
  it("land where the track store reads them, are kept by the reconciliation and get their records (PR-003)", async () => {
    const startedAt = Date.UTC(2026, 9, 1, 7);
    const points = Array.from({ length: 240 }, (_, index) => {
      const latitude = (home.latitudeE7 + Math.round((index * 3) / metersPerE7)) / 1e7;
      return `<trkpt lat="${latitude.toFixed(7)}" lon="${(home.longitudeE7 / 1e7).toFixed(7)}"><ele>250</ele><time>${new Date(startedAt + index * 1000).toISOString()}</time></trkpt>`;
    });
    const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><type>running</type><trkseg>${points.join("")}</trkseg></trk></gpx>`;
    const computation = computeImport(readActivityFile(new TextEncoder().encode(gpx)), { sport: "run", values: {} });
    const plan = planImport(db(), environment, { computation, timeZone: "Europe/Paris", replaceSessionId: null });
    if (plan.track === null) throw new Error("No track");
    const stored = await writeTrack(plan.recordingId, plan.track.bytes);
    expect(stored).toEqual({ file: plan.track.path, sha256: plan.track.sha256, bytes: plan.track.bytes.length });
    commit(db(), environment, plan.request);
    expect((await reconcileRecordingFiles(writer)).deletedTracks).toBe(0);
    expect(readTrackFile(plan.track.path)).toEqual(plan.track.bytes);
    await new DerivedRebuild(writer, (error) => {
      throw error;
    }).request();
    expect(db().select().from(recordingDerivation).where(eq(recordingDerivation.sessionId, plan.sessionId)).get()).toBeDefined();
  });
});

describe("zone proposal", () => {
  it("offers a recurring start once, accepted or declined (PRV-014)", async () => {
    const runs: Recorded[] = [];
    for (let index = 0; index < 5; index += 1) runs.push(await recorded(60, true));
    await new DerivedRebuild(writer, (error) => {
      throw error;
    }).request();
    const last = runs.at(-1)?.sessionId as Id;
    const proposal = zoneProposalFor(db(), last);
    if (proposal === null) throw new Error("No proposal");
    const plan = zoneFromProposal(proposal, "Maison");
    write("Zone ajoutée", [plan.mutation]);
    settleZoneProposal(proposal);
    expect(zoneProposalFor(db(), last)).toBeNull();
    expect(db().select().from(session).all()).toHaveLength(5);
  });
});
