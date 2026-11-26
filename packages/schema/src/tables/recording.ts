import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { SportKey } from "../catalog/sports.ts";
import { id, ref, timestamp, tracked, trashable } from "../columns.ts";
import { cadenceSources, elevationSources, energyMethods, importFormats, lapTriggers, recordingSources, segmentFamilies, sensorSources } from "../enums.ts";
import type { BoundingBoxE7, RecordingWeather } from "../recording.ts";
import { session } from "./sessions.ts";

export type BestEffortKey = `${SportKey}:distance:${number}` | `${SportKey}:ascent_1h`;

export const recording = sqliteTable(
  "recording",
  {
    id: id(),
    sessionId: ref("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
    source: text("source", { enum: recordingSources }).notNull(),
    importFormat: text("import_format", { enum: importFormats }),
    externalId: text("external_id"),
    device: text("device").notNull(),
    algorithmVersion: integer("algorithm_version").notNull(),
    autoPause: integer("auto_pause", { mode: "boolean" }).notNull(),
    elevationSource: text("elevation_source", { enum: elevationSources }).notNull(),
    cadenceSource: text("cadence_source", { enum: cadenceSources }).notNull(),
    heartRateSource: text("heart_rate_source", { enum: sensorSources }).notNull(),
    simulated: integer("simulated", { mode: "boolean" }).notNull(),
    trimStartMs: integer("trim_start_ms").notNull(),
    trimEndMs: integer("trim_end_ms"),
    elapsedMs: integer("elapsed_ms").notNull(),
    movingMs: integer("moving_ms").notNull(),
    distanceMm: integer("distance_mm").notNull(),
    ascentMm: integer("ascent_mm"),
    descentMm: integer("descent_mm"),
    altitudeMinMm: integer("altitude_min_mm"),
    altitudeMaxMm: integer("altitude_max_mm"),
    speedMaxMmS: integer("speed_max_mm_s"),
    cadenceAvg: integer("cadence_avg"),
    steps: integer("steps"),
    heartRateAvg: integer("heart_rate_avg"),
    heartRateMax: integer("heart_rate_max"),
    heartRateDevice: text("heart_rate_device"),
    energyKcal: integer("energy_kcal"),
    energyMethod: text("energy_method", { enum: energyMethods }),
    importedEnergyKcal: integer("imported_energy_kcal"),
    weather: text("weather", { mode: "json" }).$type<RecordingWeather>(),
    goodFixPermille: integer("good_fix_permille").notNull(),
    bbox: text("bbox", { mode: "json" }).$type<BoundingBoxE7>(),
    previewPolyline: text("preview_polyline"),
    trackFile: text("track_file"),
    trackSha256: text("track_sha256"),
    trackBytes: integer("track_bytes"),
    pointCount: integer("point_count").notNull(),
    ...tracked(),
  },
  (t) => [
    uniqueIndex("recording_session").on(t.sessionId),
    uniqueIndex("recording_external").on(t.externalId).where(sql`${t.externalId} IS NOT NULL`),
    check("recording_times", sql`${t.movingMs} BETWEEN 0 AND ${t.elapsedMs}`),
    check("recording_trim", sql`${t.trimStartMs} >= 0 AND (${t.trimEndMs} IS NULL OR ${t.trimEndMs} > ${t.trimStartMs})`),
    check("recording_import", sql`(${t.source} = 'import') = (${t.importFormat} IS NOT NULL)`),
    check("recording_track", sql`(${t.trackFile} IS NULL) = (${t.trackSha256} IS NULL) AND (${t.trackFile} IS NULL) = (${t.trackBytes} IS NULL)`),
    check("recording_distance", sql`${t.distanceMm} >= 0 AND ${t.pointCount} >= 0`),
    check("recording_good_fix", sql`${t.goodFixPermille} BETWEEN 0 AND 1000`),
    check("recording_energy", sql`(${t.energyKcal} IS NULL) = (${t.energyMethod} IS NULL) AND (${t.energyKcal} IS NULL OR ${t.energyKcal} BETWEEN 0 AND 30000)`),
  ],
);

export const lap = sqliteTable(
  "lap",
  {
    id: id(),
    sessionId: ref("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    trigger: text("trigger", { enum: lapTriggers }).notNull(),
    startOffsetMs: integer("start_offset_ms").notNull(),
    endOffsetMs: integer("end_offset_ms").notNull(),
  },
  (t) => [uniqueIndex("lap_position").on(t.sessionId, t.position), check("lap_bounds", sql`${t.startOffsetMs} >= 0 AND ${t.endOffsetMs} > ${t.startOffsetMs}`)],
);

export const privacyZone = sqliteTable(
  "privacy_zone",
  {
    id: id(),
    label: text("label").notNull(),
    latitudeE7: integer("latitude_e7").notNull(),
    longitudeE7: integer("longitude_e7").notNull(),
    radiusMeters: integer("radius_meters").notNull(),
    maskScalePermille: integer("mask_scale_permille").notNull(),
    ...trashable(),
  },
  (t) => [
    check("privacy_zone_radius", sql`${t.radiusMeters} BETWEEN 100 AND 2000`),
    check("privacy_zone_mask", sql`${t.maskScalePermille} BETWEEN 1000 AND 1300`),
    check("privacy_zone_position", sql`${t.latitudeE7} BETWEEN -900000000 AND 900000000 AND ${t.longitudeE7} BETWEEN -1800000000 AND 1800000000`),
  ],
);

export const bestEffort = sqliteTable(
  "best_effort",
  {
    sessionId: ref("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
    effort: text("effort").$type<BestEffortKey>().notNull(),
    elapsedMs: integer("elapsed_ms").notNull(),
    movingMs: integer("moving_ms").notNull(),
    startOffsetMs: integer("start_offset_ms").notNull(),
    ascentMm: integer("ascent_mm"),
    algorithmVersion: integer("algorithm_version").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.effort] }),
    index("best_effort_rank").on(t.effort, t.elapsedMs),
    index("best_effort_ascent").on(t.effort, t.ascentMm).where(sql`${t.ascentMm} IS NOT NULL`),
    check("best_effort_ascent_kind", sql`(${t.effort} LIKE '%:ascent_1h') = (${t.ascentMm} IS NOT NULL)`),
  ],
);

/**
 * What the derived rows of a live recording were last computed from, outside the journal: its `best_effort` rows
 * (`DAT-012`, `PR-003`) and its stored preview (`PRV-010`) are current while its session and recording rows, the
 * algorithm and the masking inputs are unchanged. Also keeps the raw ends of the track for the zone proposal (`PRV-014`).
 */
export const recordingDerivation = sqliteTable(
  "recording_derivation",
  {
    sessionId: ref("session_id")
      .primaryKey()
      .references(() => session.id, { onDelete: "cascade" }),
    sessionUpdatedAt: timestamp("session_updated_at").notNull(),
    recordingUpdatedAt: timestamp("recording_updated_at").notNull(),
    algorithmVersion: integer("algorithm_version").notNull(),
    maskKey: text("mask_key").notNull(),
    startLatitudeE7: integer("start_latitude_e7"),
    startLongitudeE7: integer("start_longitude_e7"),
    endLatitudeE7: integer("end_latitude_e7"),
    endLongitudeE7: integer("end_longitude_e7"),
  },
  (t) => [
    check(
      "recording_derivation_ends",
      sql`(${t.startLatitudeE7} IS NULL) = (${t.startLongitudeE7} IS NULL) AND (${t.startLatitudeE7} IS NULL) = (${t.endLatitudeE7} IS NULL) AND (${t.startLatitudeE7} IS NULL) = (${t.endLongitudeE7} IS NULL)`,
    ),
  ],
);

/**
 * The deferred weather request of a saved recording after a failed attempt, outside the journal and the backups (`WTH-003`):
 * how many attempts failed and when the next one may run, `null` once the request is given up.
 */
export const weatherFetch = sqliteTable(
  "weather_fetch",
  {
    sessionId: ref("session_id")
      .primaryKey()
      .references(() => session.id, { onDelete: "cascade" }),
    failedAttempts: integer("failed_attempts").notNull(),
    retryAt: timestamp("retry_at"),
  },
  (t) => [check("weather_fetch_attempts", sql`${t.failedAttempts} >= 1`)],
);

/** Recurring places already offered as a privacy zone, accepted or not: each place is proposed only once (`PRV-014`). */
export const zoneProposal = sqliteTable("zone_proposal", {
  id: id(),
  latitudeE7: integer("latitude_e7").notNull(),
  longitudeE7: integer("longitude_e7").notNull(),
  proposedAt: timestamp("proposed_at").notNull(),
});

export const segment = sqliteTable(
  "segment",
  {
    id: id(),
    name: text("name").notNull(),
    family: text("family", { enum: segmentFamilies }).notNull(),
    polyline: text("polyline").notNull(),
    distanceMm: integer("distance_mm").notNull(),
    ascentMm: integer("ascent_mm").notNull(),
    bbox: text("bbox", { mode: "json" }).$type<BoundingBoxE7>().notNull(),
    south: integer("south").notNull(),
    north: integer("north").notNull(),
    sourceSessionId: ref("source_session_id").references(() => session.id, { onDelete: "set null" }),
    ...trashable(),
  },
  (t) => [index("segment_bbox").on(t.family, t.south, t.north), check("segment_distance", sql`${t.distanceMm} >= 100000`)],
);

/** The geometry of a segment its `segment_effort` rows were last searched for over the whole history (`SEG-003`), outside the journal. */
export const segmentDerivation = sqliteTable("segment_derivation", {
  segmentId: ref("segment_id")
    .primaryKey()
    .references(() => segment.id, { onDelete: "cascade" }),
  shapeKey: text("shape_key").notNull(),
});

export const segmentEffort = sqliteTable(
  "segment_effort",
  {
    segmentId: ref("segment_id").notNull().references(() => segment.id, { onDelete: "cascade" }),
    sessionId: ref("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
    occurrence: integer("occurrence").notNull(),
    startOffsetMs: integer("start_offset_ms").notNull(),
    elapsedMs: integer("elapsed_ms").notNull(),
    movingMs: integer("moving_ms").notNull(),
    heartRateAvg: integer("heart_rate_avg"),
    algorithmVersion: integer("algorithm_version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.segmentId, t.sessionId, t.occurrence] }), index("segment_effort_rank").on(t.segmentId, t.elapsedMs)],
);
