import { isNull } from "drizzle-orm";
import { privacyZone } from "@obnixe/schema";
import type { Id, PrivacyZone } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import { readSettings } from "../settings.ts";
import type { Mutation } from "../writer.ts";
import type { GeoPoint } from "./geo.ts";
import type { MaskOptions, MaskZone } from "./privacy.ts";

/** Radius chosen by the user (`PRV-010`), also enforced by the `privacy_zone_radius` check. */
export const privacyZoneRadiusBounds = { minMeters: 100, maxMeters: 2000 } as const;

export interface PrivacyZoneDraft {
  readonly label: string;
  /** Center in degrees, rounded to 1e-7 degree when stored. */
  readonly center: GeoPoint;
  readonly radiusMeters: number;
}

export type PrivacyZoneProblem = "label" | "radius" | "position";

export class InvalidPrivacyZoneError extends Error {
  constructor(readonly problem: PrivacyZoneProblem) {
    super(`Invalid privacy zone ${problem}`);
  }
}

export interface PrivacyZonePlan {
  readonly zoneId: Id;
  readonly mutation: Mutation;
}

type ZoneFields = Pick<PrivacyZone, "label" | "latitudeE7" | "longitudeE7" | "radiusMeters">;

export function privacyZoneProblem(draft: PrivacyZoneDraft): PrivacyZoneProblem | null {
  if (draft.label.trim() === "") return "label";
  const { minMeters, maxMeters } = privacyZoneRadiusBounds;
  if (!Number.isInteger(draft.radiusMeters) || draft.radiusMeters < minMeters || draft.radiusMeters > maxMeters) return "radius";
  const { latitude, longitude } = draft.center;
  if (!(Math.abs(latitude) <= 90) || !(Math.abs(longitude) <= 180)) return "position";
  return null;
}

function zoneFields(draft: PrivacyZoneDraft): ZoneFields {
  const problem = privacyZoneProblem(draft);
  if (problem !== null) throw new InvalidPrivacyZoneError(problem);
  return {
    label: draft.label.trim(),
    latitudeE7: Math.round(draft.center.latitude * 1e7),
    longitudeE7: Math.round(draft.center.longitude * 1e7),
    radiusMeters: draft.radiusMeters,
  };
}

/** `maskScalePermille` is the zone's draw from `drawMaskScalePermille`, kept for the zone's whole life (`PRV-012`). */
export function newPrivacyZone(env: Environment, draft: PrivacyZoneDraft, maskScalePermille: number): PrivacyZonePlan {
  const zoneId = env.newId();
  return { zoneId, mutation: { kind: "insert", table: "privacy_zone", row: { id: zoneId, ...zoneFields(draft), maskScalePermille, deletedAt: null } } };
}

/** The changed fields of a zone, or null when the draft matches it; the mask draw never changes. */
export function editPrivacyZone(zone: PrivacyZone, draft: PrivacyZoneDraft): Mutation | null {
  const fields = zoneFields(draft);
  const patch: Partial<ZoneFields> = {};
  if (fields.label !== zone.label) patch.label = fields.label;
  if (fields.latitudeE7 !== zone.latitudeE7) patch.latitudeE7 = fields.latitudeE7;
  if (fields.longitudeE7 !== zone.longitudeE7) patch.longitudeE7 = fields.longitudeE7;
  if (fields.radiusMeters !== zone.radiusMeters) patch.radiusMeters = fields.radiusMeters;
  if (Object.keys(patch).length === 0) return null;
  return { kind: "update", table: "privacy_zone", key: zone.id, patch };
}

/** What `maskTrack` removes from everything that leaves the detail screen. */
export interface PrivacyMask extends MaskOptions {
  readonly zones: readonly MaskZone[];
}

/** The zones outside the trash and `settings.hide_track_ends_meters` (`PRV-010`, `PRV-012`): previews, shares, the agent. */
export function activePrivacyMask(db: ObnixeDatabase): PrivacyMask {
  const zones = db
    .select({ latitudeE7: privacyZone.latitudeE7, longitudeE7: privacyZone.longitudeE7, radiusMeters: privacyZone.radiusMeters, maskScalePermille: privacyZone.maskScalePermille })
    .from(privacyZone)
    .where(isNull(privacyZone.deletedAt))
    .all();
  return { zones, hideEndsMeters: readSettings(db).hideTrackEndsMeters };
}

/** The mask of the detail map: the full track for its owner, unless `settings.mask_in_app` asks otherwise (`PRV-010`, `Q-18`). */
export function detailPrivacyMask(db: ObnixeDatabase): PrivacyMask | null {
  return readSettings(db).maskInApp ? activePrivacyMask(db) : null;
}

/**
 * The mask of a file export (`PRV-011`): the active mask, or none when the user includes the full track. The box is unchecked
 * by default while `settings.export_privacy` is on.
 */
export function exportPrivacyMask(db: ObnixeDatabase, includeFullTrack: boolean = !readSettings(db).exportPrivacy): PrivacyMask | null {
  return includeFullTrack ? null : activePrivacyMask(db);
}
