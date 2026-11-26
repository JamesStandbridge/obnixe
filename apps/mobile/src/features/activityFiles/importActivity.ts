import { inArray } from "drizzle-orm";
import { commit, decodeTrack, findImportDuplicate, findImportMerge, ImportError, importMergeSummary, importSummary, planImport, planImportMerge, readActivityFile, simplifyPath } from "@obnixe/core";
import type { ImportComputation, ImportedActivity, ImportErrorReason, ImportMerge, SportGuess } from "@obnixe/core";
import { session, sportKeys, sports } from "@obnixe/schema";
import type { EpochMs, Id, SportKey } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import type { LngLat } from "@/features/maps/surface";
import type { Bounds } from "@/features/maps/tiles";
import { readTrack, writeTrack } from "@/features/tracking/trackStore";
import { deviceTimeZone } from "@/format/dates";

export type ActivityReading = { readonly kind: "read"; readonly activity: ImportedActivity } | { readonly kind: "refused"; readonly message: string };

/** What the import of a measured file meets in the journal (`IO-012`, `IO-052`). */
export type ImportMatch =
  | { readonly kind: "new" }
  | { readonly kind: "already_imported"; readonly sessionId: Id }
  | { readonly kind: "probable"; readonly sessionIds: readonly Id[] }
  | { readonly kind: "merge"; readonly merge: ImportMerge };

export type ImportDecision =
  | { readonly kind: "import"; readonly replaceSessionId: Id | null }
  | { readonly kind: "merge"; readonly merge: ImportMerge; readonly replaceAltitude: boolean };

export interface ImportResult {
  readonly sessionId: Id;
  readonly changesetId: Id;
  readonly summary: string;
}

export interface PreviewPath {
  readonly coordinates: readonly LngLat[];
  readonly bounds: Bounds;
}

export class MergeTrackUnavailableError extends Error {
  constructor(readonly file: string) {
    super(`Track ${file} of the recording to merge is missing`);
  }
}

const previewToleranceMeters = 5;
const previewMaxPoints = 800;

/** `IO-013`: every refusal names what is wrong with the file. */
export function importErrorMessage(reason: ImportErrorReason): string {
  switch (reason) {
    case "unsupported_format":
      return "Format non pris en charge. Choisis un fichier GPX, TCX ou FIT, ou un ZIP Garmin.";
    case "malformed":
      return "Fichier abîmé, impossible à lire";
    case "checksum":
      return "Fichier FIT corrompu : la somme de contrôle ne correspond pas";
    case "truncated":
      return "Fichier incomplet : il s'arrête avant la fin";
    case "not_an_activity":
      return "Ce fichier n'est pas une activité (parcours, réglages ou autre)";
    case "not_a_route":
      return "Ce fichier n'est pas un itinéraire";
    case "several_activities":
      return "Ce fichier contient plusieurs activités. Importe-les une par une.";
    case "no_activity_data":
      return "Aucune donnée d'activité dans ce fichier";
    case "untimed":
      return "Points sans heure : c'est un itinéraire, pas une activité enregistrée";
    case "unordered_time":
      return "Les heures des points reviennent en arrière";
    case "invalid_coordinates":
      return "Des positions sont hors des limites de la Terre";
    case "invalid_value":
      return "Fichier trop grand ou valeurs impossibles";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

export function readActivity(bytes: Uint8Array): ActivityReading {
  try {
    return { kind: "read", activity: readActivityFile(bytes) };
  } catch (error) {
    if (error instanceof ImportError) return { kind: "refused", message: importErrorMessage(error.reason) };
    throw error;
  }
}

/** The detected sport first, then the sports the engine measures from positions (`IO-010`). */
export function importSports(detected: SportGuess | null): readonly SportKey[] {
  const measured = sportKeys.filter((key) => sports[key].recording !== null);
  return detected === null || measured.includes(detected.sport) ? measured : [detected.sport, ...measured];
}

/** The detected variant stays with the detected sport; another sport starts without one. */
export function sportChoice(detected: SportGuess | null, sport: SportKey): SportGuess {
  return detected !== null && detected.sport === sport ? detected : { sport, values: {} };
}

/** A file already imported comes first; then a phone recording it completes, before a probable duplicate. */
export function matchImport(computation: ImportComputation): ImportMatch {
  const duplicate = findImportDuplicate(db(), computation);
  if (duplicate.kind === "already_imported") return duplicate;
  const merge = findImportMerge(db(), computation);
  if (merge !== null) return { kind: "merge", merge };
  return duplicate.kind === "probable" ? duplicate : { kind: "new" };
}

/** How the user settles a match: `keep` imports alongside, `ignore` imports nothing (`IO-012`, `IO-052`). */
export type Resolution = "keep" | "ignore" | "replace" | "merge";

export interface ResolutionOption {
  readonly value: Resolution;
  readonly label: string;
}

/** Ignore is the default for a duplicate (`IO-012`), merge for a phone recording the file completes (`IO-052`). */
export function resolutionsOf(match: ImportMatch): readonly ResolutionOption[] {
  switch (match.kind) {
    case "new":
      return [{ value: "keep", label: "Importer" }];
    case "already_imported":
      return [
        { value: "ignore", label: "Garder" },
        { value: "replace", label: "Remplacer" },
      ];
    case "probable":
      return [
        { value: "ignore", label: "Ignorer" },
        { value: "replace", label: "Remplacer" },
        { value: "keep", label: "Garder les deux" },
      ];
    case "merge":
      return [
        { value: "merge", label: "Fusionner" },
        { value: "keep", label: "À part" },
        { value: "ignore", label: "Ignorer" },
      ];
    default: {
      const unreachable: never = match;
      throw new Error(`Unhandled import match ${JSON.stringify(unreachable)}`);
    }
  }
}

export function defaultResolution(match: ImportMatch): Resolution {
  return resolutionsOf(match)[0]?.value ?? "keep";
}

/** The session a match is about: the one holding the file, the closest probable duplicate, or the phone recording to complete. */
export interface MatchedSession {
  readonly sessionId: Id;
  readonly startedAt: EpochMs;
}

export function matchedSession(match: ImportMatch, startedAt: EpochMs): MatchedSession | null {
  const ids = match.kind === "new" ? [] : match.kind === "already_imported" ? [match.sessionId] : match.kind === "merge" ? [match.merge.sessionId] : match.sessionIds;
  if (ids.length === 0) return null;
  const rows = db().select({ sessionId: session.id, startedAt: session.startedAt }).from(session).where(inArray(session.id, [...ids])).all();
  return rows.reduce<MatchedSession | null>((best, row) => (best === null || Math.abs(row.startedAt - startedAt) < Math.abs(best.startedAt - startedAt) ? row : best), null);
}

/** `null`: nothing is imported. */
export function decisionOf(match: ImportMatch, resolution: Resolution, matched: MatchedSession | null, replaceAltitude: boolean): ImportDecision | null {
  switch (resolution) {
    case "ignore":
      return null;
    case "keep":
      return { kind: "import", replaceSessionId: null };
    case "replace":
      return matched === null ? null : { kind: "import", replaceSessionId: matched.sessionId };
    case "merge":
      return match.kind === "merge" ? { kind: "merge", merge: match.merge, replaceAltitude: replaceAltitude && match.merge.offersAltitude } : null;
    default: {
      const unreachable: never = resolution;
      throw new Error(`Unhandled resolution ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The simplified line of the preview map, in the file's full detail: the owner sees their whole track before importing. */
export function previewPath(computation: ImportComputation): PreviewPath | null {
  const { processed } = computation;
  const { fixes } = computation.track.samples;
  const latitude = processed === null ? Float64Array.from(fixes.latitudeE7, (value) => value / 1e7) : processed.series.latitude;
  const longitude = processed === null ? Float64Array.from(fixes.longitudeE7, (value) => value / 1e7) : processed.series.longitude;
  if (latitude.length < 2) return null;
  const kept = simplifyPath(latitude, longitude, previewToleranceMeters, previewMaxPoints);
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  const coordinates = Array.from(kept, (index): LngLat => {
    const lng = longitude[index] ?? 0;
    const lat = latitude[index] ?? 0;
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    return [lng, lat];
  });
  return { coordinates, bounds: [west, south, east, north] };
}

/** Writes the track first and verifies it (`DAT-020`), then commits the changeset that references it. */
export async function commitImport(computation: ImportComputation, decision: ImportDecision): Promise<ImportResult> {
  switch (decision.kind) {
    case "import": {
      const plan = planImport(db(), environment, { computation, timeZone: deviceTimeZone(), replaceSessionId: decision.replaceSessionId });
      if (plan.track !== null) await writeTrack(plan.recordingId, plan.track.bytes);
      return { sessionId: plan.sessionId, changesetId: commit(db(), environment, plan.request), summary: importSummary };
    }
    case "merge": {
      const { merge } = decision;
      const bytes = await readTrack(merge.trackFile);
      if (bytes === null) throw new MergeTrackUnavailableError(merge.trackFile);
      const plan = planImportMerge(db(), environment, { computation, merge, phoneTrack: decodeTrack(bytes), replaceAltitude: decision.replaceAltitude });
      await writeTrack(plan.recordingId, plan.track.bytes);
      return { sessionId: plan.sessionId, changesetId: commit(db(), environment, plan.request), summary: importMergeSummary };
    }
    default: {
      const unreachable: never = decision;
      throw new Error(`Unhandled import decision ${JSON.stringify(unreachable)}`);
    }
  }
}
