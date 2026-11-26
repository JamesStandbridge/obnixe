import type { Id } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import { encodeTrack, trackDigest, trackFilePath } from "./codec/track.ts";
import type { Track } from "./codec/track.ts";
import { planTerrainReplacement } from "./plans.ts";
import type { RecordingRewrite } from "./plans.ts";
import { noTerrain } from "./types.ts";
import type { TerrainColumns } from "./types.ts";

/** The new track file of a corrected or restored recording, written and verified before the commit (`DAT-020`). */
export interface TerrainTrackFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface TerrainPlan {
  readonly recordingId: Id;
  readonly file: TerrainTrackFile;
  readonly rewrite: RecordingRewrite;
}

/**
 * *Corriger l'altitude* (`ELE-003`): the recording moves to a new track file holding the DEM altitude next to the recorded
 * one, and everything is measured again from it, `elevation_source` becoming `dem`. The previous file stays for an undo.
 */
export function planElevationCorrection(db: ObnixeDatabase, env: Environment, sessionId: Id, track: Track, terrain: TerrainColumns): TerrainPlan {
  const replaced: Track = { ...track, samples: { ...track.samples, terrain } };
  const bytes = encodeTrack(replaced);
  const recordingId = env.newId();
  const file: TerrainTrackFile = { path: trackFilePath(recordingId), bytes, sha256: trackDigest(bytes) };
  const rewrite = planTerrainReplacement(db, env, sessionId, { recordingId, track: replaced, stored: { file: file.path, sha256: file.sha256, bytes: bytes.length }, patch: {} });
  return { recordingId, file, rewrite };
}

/** `ELE-003` reversibility: the recording measured again from its recorded altitude, the DEM altitude left out of the new file. */
export function planElevationRestore(db: ObnixeDatabase, env: Environment, sessionId: Id, track: Track): TerrainPlan {
  return planElevationCorrection(db, env, sessionId, track, noTerrain);
}
