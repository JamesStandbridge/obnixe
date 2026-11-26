import { maskTrack } from "./privacy.ts";
import type { TrackPositions } from "./privacy.ts";
import type { PrivacyMask } from "./privacyZones.ts";
import { previewMaxPoints, previewToleranceMeters, simplifyPath } from "./simplify.ts";

/** The box the track is drawn in, in image units. */
export interface ShareFrame {
  readonly width: number;
  readonly height: number;
}

export interface SharePoint {
  readonly x: number;
  readonly y: number;
}

/** The stylized track of the share image (`SUM-006`), without map background. */
export interface ShareTrack {
  /** One line per visible run of the masked track, so no line crosses a hidden part. */
  readonly runs: readonly (readonly SharePoint[])[];
  readonly start: SharePoint;
  readonly end: SharePoint;
}

const radiansPerDegree = Math.PI / 180;

/**
 * Indices of the points drawn on the share image: the visible runs of `maskTrack` with the active mask, exactly what the
 * stored preview keeps (`PRV-010`, `PRV-012`), each simplified at the preview tolerance within the preview point budget.
 * Runs of a single point draw nothing and are dropped.
 */
export function shareTrackRuns(track: TrackPositions, mask: PrivacyMask): readonly Uint32Array[] {
  const masked = maskTrack(track, mask.zones, mask);
  const runs = masked.visible.filter((range) => range.end - range.start >= 2);
  const visible = runs.reduce((total, range) => total + range.end - range.start, 0);
  return runs.map(({ start, end }) => {
    const budget = Math.max(2, Math.floor((previewMaxPoints * (end - start)) / visible));
    const kept = simplifyPath(track.latitude.subarray(start, end), track.longitude.subarray(start, end), previewToleranceMeters, budget);
    return kept.map((index) => index + start);
  });
}

/**
 * The visible runs projected in `frame`, in proportion and centered, north up; `null` when the mask leaves nothing to draw.
 * The extent comes from the visible points only, so the hidden parts do not shape the drawing either.
 */
export function shareTrack(track: TrackPositions, mask: PrivacyMask, frame: ShareFrame): ShareTrack | null {
  const runs = shareTrackRuns(track, mask);
  if (runs.length === 0) return null;
  let south = Infinity;
  let north = -Infinity;
  for (const run of runs) {
    for (const index of run) {
      const latitude = track.latitude[index] ?? 0;
      south = Math.min(south, latitude);
      north = Math.max(north, latitude);
    }
  }
  const cosine = Math.cos(((south + north) / 2) * radiansPerDegree);
  const reference = track.longitude[runs[0]?.[0] ?? 0] ?? 0;
  const eastOf = (index: number): number => {
    const delta = (track.longitude[index] ?? 0) - reference;
    return (delta > 180 ? delta - 360 : delta < -180 ? delta + 360 : delta) * cosine;
  };
  let west = Infinity;
  let east = -Infinity;
  for (const run of runs) {
    for (const index of run) {
      const x = eastOf(index);
      west = Math.min(west, x);
      east = Math.max(east, x);
    }
  }
  const spanX = Math.max(east - west, 1e-9);
  const spanY = Math.max(north - south, 1e-9);
  const scale = Math.min(frame.width / spanX, frame.height / spanY);
  const offsetX = (frame.width - spanX * scale) / 2;
  const offsetY = (frame.height - spanY * scale) / 2;
  const at = (index: number): SharePoint => ({ x: offsetX + (eastOf(index) - west) * scale, y: offsetY + (north - (track.latitude[index] ?? 0)) * scale });
  const projected = runs.map((run) => Array.from(run, at));
  const first = projected[0]?.[0];
  const lastRun = projected[projected.length - 1];
  const last = lastRun?.[lastRun.length - 1];
  if (first === undefined || last === undefined) return null;
  return { runs: projected, start: first, end: last };
}
