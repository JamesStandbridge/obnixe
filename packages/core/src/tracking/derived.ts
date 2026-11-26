import { and, asc, count, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { bestEffort, recording, recordingDerivation, session, zoneProposal } from "@obnixe/schema";
import type { EpochMs, FieldValues, Id, Recording, Session, SportKey } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import { readSettings } from "../settings.ts";
import type { Mutation } from "../writer.ts";
import type { ProcessedTrack } from "./batch.ts";
import type { Track } from "./codec/track.ts";
import { ellipsoidDistance } from "./geo.ts";
import type { GeoPoint } from "./geo.ts";
import { maskTrack } from "./privacy.ts";
import { previewPolyline } from "./simplify.ts";
import { activePrivacyMask } from "./privacyZones.ts";
import type { PrivacyMask } from "./privacyZones.ts";
import type { TrackSeries } from "./stages/derive.ts";
import { trackingAlgorithmVersion } from "./version.ts";
import { proposeZone, zoneProposalRules } from "./zoneProposal.ts";
import type { ActivityEnds, ZoneProposal } from "./zoneProposal.ts";

/** `DAT-012`: stale derived rows are rebuilt by batches of 20 sessions. */
export const derivationBatchSize = 20;

/** `PR-002`: below this share of the moving time within 20 m, an activity counts in no record. */
export const recordsMinGoodFixPermille = 500;

/** Changes exactly when the masking of a preview would; stored with each derivation. */
export function maskKey(mask: PrivacyMask): string {
  const zones = mask.zones.map((zone) => `${zone.latitudeE7},${zone.longitudeE7},${zone.radiusMeters},${zone.maskScalePermille}`).sort();
  return [mask.hideEndsMeters, ...zones].join(";");
}

/** The preview never shows a point of a zone or of the hidden ends (`PRV-010`). */
export function maskedPreview(series: TrackSeries, mask: PrivacyMask): string | null {
  return previewPolyline(series, maskTrack(series, mask.zones, mask));
}

export type RecordsRow = Pick<Recording, "simulated" | "goodFixPermille" | "pointCount">;

/** `PR-002`: simulated tracks, tracks without positions or with a poor signal, and electric bikes for bike records, count in no record. */
export function countsInRecords(row: RecordsRow, sport: SportKey, values: FieldValues): boolean {
  if (row.simulated || row.pointCount === 0 || row.goodFixPermille < recordsMinGoodFixPermille) return false;
  return !(sport === "bike" && values.e_bike === true);
}

/** A saved recording, recorded or imported, whose derived rows no longer match it. */
export interface StaleDerivation {
  readonly session: Session;
  readonly recording: Recording;
}

function isStale(mask: PrivacyMask): SQL | undefined {
  return and(
    isNotNull(recording.trackFile),
    eq(session.status, "completed"),
    or(
      isNull(recordingDerivation.sessionId),
      ne(recordingDerivation.sessionUpdatedAt, session.updatedAt),
      ne(recordingDerivation.recordingUpdatedAt, recording.updatedAt),
      ne(recordingDerivation.algorithmVersion, trackingAlgorithmVersion),
      ne(recordingDerivation.maskKey, maskKey(mask)),
    ),
  );
}

/**
 * Saved recordings, trashed ones included so a restore finds them current, whose best efforts or preview were
 * computed from other rows, another algorithm or other masking inputs, or never.
 */
export function staleDerivations(db: ObnixeDatabase, mask: PrivacyMask, limit: number): readonly StaleDerivation[] {
  return db
    .select({ session, recording })
    .from(recording)
    .innerJoin(session, eq(session.id, recording.sessionId))
    .leftJoin(recordingDerivation, eq(recordingDerivation.sessionId, recording.sessionId))
    .where(isStale(mask))
    .orderBy(asc(session.startedAt))
    .limit(limit)
    .all();
}

export function staleDerivationCount(db: ObnixeDatabase, mask: PrivacyMask): number {
  return (
    db
      .select({ stale: count() })
      .from(recording)
      .innerJoin(session, eq(session.id, recording.sessionId))
      .leftJoin(recordingDerivation, eq(recordingDerivation.sessionId, recording.sessionId))
      .where(isStale(mask))
      .get()?.stale ?? 0
  );
}

/** The preview update of a rebuilt derivation, `null` when the stored one is already right. */
export function previewMutationOf(current: Recording, processed: ProcessedTrack, mask: PrivacyMask): Mutation | null {
  const preview = maskedPreview(processed.series, mask);
  return preview === current.previewPolyline ? null : { kind: "update", table: "recording", key: current.id, patch: { previewPolyline: preview } };
}

function endsOf(track: Track): ActivityEnds | null {
  const { fixes } = track.samples;
  if (fixes.length === 0) return null;
  const last = fixes.length - 1;
  return {
    start: { latitude: (fixes.latitudeE7[0] ?? 0) / 1e7, longitude: (fixes.longitudeE7[0] ?? 0) / 1e7 },
    end: { latitude: (fixes.latitudeE7[last] ?? 0) / 1e7, longitude: (fixes.longitudeE7[last] ?? 0) / 1e7 },
  };
}

/**
 * Replaces the session's `best_effort` rows (`PR-001`, `PR-002`) and marks its derivation current, outside the journal.
 * Reads the session and recording rows as they are now, so call it after the commit of the preview they show.
 */
export function storeDerivation(db: ObnixeDatabase, sessionId: Id, track: Track, processed: ProcessedTrack, mask: PrivacyMask): void {
  db.transaction((tx) => {
    const current = tx.select({ session, recording }).from(recording).innerJoin(session, eq(session.id, recording.sessionId)).where(eq(recording.sessionId, sessionId)).get();
    if (current === undefined) return;
    tx.delete(bestEffort).where(eq(bestEffort.sessionId, sessionId)).run();
    if (countsInRecords(current.recording, current.session.sport, current.session.values) && processed.bestEfforts.length > 0) {
      tx.insert(bestEffort)
        .values(processed.bestEfforts.map((effort) => ({ sessionId, ...effort, algorithmVersion: processed.algorithmVersion })))
        .run();
    }
    const ends = endsOf(track);
    const row = {
      sessionUpdatedAt: current.session.updatedAt,
      recordingUpdatedAt: current.recording.updatedAt,
      algorithmVersion: processed.algorithmVersion,
      maskKey: maskKey(mask),
      startLatitudeE7: ends === null ? null : Math.round(ends.start.latitude * 1e7),
      startLongitudeE7: ends === null ? null : Math.round(ends.start.longitude * 1e7),
      endLatitudeE7: ends === null ? null : Math.round(ends.end.latitude * 1e7),
      endLongitudeE7: ends === null ? null : Math.round(ends.end.longitude * 1e7),
    };
    tx.insert(recordingDerivation)
      .values({ sessionId, ...row })
      .onConflictDoUpdate({ target: recordingDerivation.sessionId, set: row })
      .run();
  });
}

function pointOf(latitudeE7: number, longitudeE7: number): GeoPoint {
  return { latitude: latitudeE7 / 1e7, longitude: longitudeE7 / 1e7 };
}

function near(from: GeoPoint, to: GeoPoint): boolean {
  return ellipsoidDistance(from.latitude, from.longitude, to.latitude, to.longitude) < zoneProposalRules.nearMeters;
}

/**
 * `PRV-014` at the save of `sessionId`: the recurring place to offer as a zone when this activity starts or finishes near
 * it, from the raw ends of every activity in force; `null` when there is none or it was already proposed.
 */
export function zoneProposalFor(db: ObnixeDatabase, sessionId: Id): ZoneProposal | null {
  const rows = db
    .select({
      sessionId: recordingDerivation.sessionId,
      startLatitudeE7: sql<number>`${recordingDerivation.startLatitudeE7}`,
      startLongitudeE7: sql<number>`${recordingDerivation.startLongitudeE7}`,
      endLatitudeE7: sql<number>`${recordingDerivation.endLatitudeE7}`,
      endLongitudeE7: sql<number>`${recordingDerivation.endLongitudeE7}`,
    })
    .from(recordingDerivation)
    .innerJoin(session, eq(session.id, recordingDerivation.sessionId))
    .where(and(isNull(session.deletedAt), isNotNull(recordingDerivation.startLatitudeE7)))
    .all();
  const own = rows.find((row) => row.sessionId === sessionId);
  if (own === undefined) return null;
  const activities = rows.map((row): ActivityEnds => ({ start: pointOf(row.startLatitudeE7, row.startLongitudeE7), end: pointOf(row.endLatitudeE7, row.endLongitudeE7) }));
  const declined = db
    .select()
    .from(zoneProposal)
    .all()
    .map((row) => pointOf(row.latitudeE7, row.longitudeE7));
  const proposal = proposeZone(activities, activePrivacyMask(db).zones, declined);
  if (proposal === null) return null;
  const ownEnds: ActivityEnds = { start: pointOf(own.startLatitudeE7, own.startLongitudeE7), end: pointOf(own.endLatitudeE7, own.endLongitudeE7) };
  return near(ownEnds.start, proposal.center) || near(ownEnds.end, proposal.center) ? proposal : null;
}

/** Keeps the offered place, whatever the answer, so it is never proposed again (`PRV-014`). */
export function recordZoneProposal(db: ObnixeDatabase, env: Environment, proposal: ZoneProposal): void {
  db.insert(zoneProposal)
    .values({ id: env.newId(), latitudeE7: Math.round(proposal.center.latitude * 1e7), longitudeE7: Math.round(proposal.center.longitude * 1e7), proposedAt: env.now() as EpochMs })
    .run();
}
