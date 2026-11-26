import { and, eq, gt, isNotNull, isNull, lt } from "drizzle-orm";
import { recording, session } from "@obnixe/schema";
import type { EpochMs, Id } from "@obnixe/schema";
import { importActor } from "../../data/backup/merge.ts";
import type { Environment, ObnixeDatabase } from "../../database.ts";
import type { CommitRequest } from "../../writer.ts";
import { encodeTrack, trackDigest, trackFilePath } from "../codec/track.ts";
import type { Track } from "../codec/track.ts";
import { planTrackReplacement } from "../plans.ts";
import { bridgeMaximumMs } from "../stages/derive.ts";
import { absentValue } from "../types.ts";
import type { FixColumns, HeartRateColumns, PressureColumns } from "../types.ts";
import { fileVerticalAccuracyDm } from "./activity.ts";
import type { ImportedActivity } from "./activity.ts";
import { externalIdRelease, fileDevice } from "./import.ts";
import type { ImportComputation, ImportTrackFile } from "./import.ts";

export const importMergeSummary = "Fusion avec une activité importée";
/** `IO-052`: the file and the phone recording each cover at least this share of the longer of the two. */
export const mergeOverlapRatio = 0.8;

const maxTrackT = 4_294_967_295;

/** A phone recording the imported file can complete instead of duplicating it (`IO-052`). */
export interface ImportMerge {
  readonly sessionId: Id;
  readonly trackFile: string;
  /** The phone recorded no heart rate and the file has some. */
  readonly addsHeartRate: boolean;
  /** The file has altitudes, from the watch barometer, that can replace the phone's. */
  readonly offersAltitude: boolean;
}

export interface ImportMergeDraft {
  readonly computation: ImportComputation;
  readonly merge: ImportMerge;
  /** The decoded `.otrk` at `merge.trackFile`. */
  readonly phoneTrack: Track;
  readonly replaceAltitude: boolean;
}

export interface ImportMergePlan {
  readonly sessionId: Id;
  readonly recordingId: Id;
  readonly track: ImportTrackFile;
  readonly request: CommitRequest;
}

export class NothingToMergeError extends Error {
  constructor(readonly sessionId: Id) {
    super(`The file adds nothing to session ${sessionId}`);
  }
}

interface FileAltitudes {
  readonly t: Float64Array;
  readonly altitudeMm: Float64Array;
}

function fileAltitudes(activity: ImportedActivity): FileAltitudes {
  const points = activity.points.filter((point) => point.altitudeMm !== null);
  return { t: Float64Array.from(points, (point) => point.t), altitudeMm: Float64Array.from(points, (point) => point.altitudeMm ?? 0) };
}

/** The file heart rate on the phone time base, `offsetMs` being the file start minus the phone start. */
function shiftedHeartRate(file: HeartRateColumns, offsetMs: number): HeartRateColumns {
  const kept: number[] = [];
  for (let index = 0; index < file.length; index += 1) {
    const t = (file.t[index] ?? 0) + offsetMs;
    if (t >= 0 && t <= maxTrackT) kept.push(index);
  }
  return {
    length: kept.length,
    t: Uint32Array.from(kept, (index) => (file.t[index] ?? 0) + offsetMs),
    bpm: Uint16Array.from(kept, (index) => file.bpm[index] ?? 0),
    rrInterval: Int32Array.from(kept, (index) => file.rrInterval[index] ?? absentValue),
  };
}

/** Each phone fix gets the file altitude interpolated at its instant, absent across a gap the processing would not bridge. */
function replacedAltitudes(fixes: FixColumns, altitudes: FileAltitudes, offsetMs: number): FixColumns {
  const altitudeMslMm = new Int32Array(fixes.length).fill(absentValue);
  const verticalAccuracyDm = new Int32Array(fixes.length).fill(absentValue);
  let next = 0;
  for (let index = 0; index < fixes.length; index += 1) {
    const t = (fixes.t[index] ?? 0) - offsetMs;
    while (next < altitudes.t.length && (altitudes.t[next] ?? 0) < t) next += 1;
    const after = altitudes.t[next];
    const before = altitudes.t[next - 1];
    let altitude: number | null = null;
    if (after === t) altitude = altitudes.altitudeMm[next] ?? null;
    else if (before !== undefined && after !== undefined && after - before <= bridgeMaximumMs) {
      const from = altitudes.altitudeMm[next - 1] ?? 0;
      altitude = from + (((altitudes.altitudeMm[next] ?? 0) - from) * (t - before)) / (after - before);
    }
    if (altitude === null) continue;
    altitudeMslMm[index] = Math.round(altitude);
    verticalAccuracyDm[index] = fileVerticalAccuracyDm;
  }
  return { ...fixes, altitudeEllipsoidMm: new Int32Array(fixes.length).fill(absentValue), altitudeMslMm, verticalAccuracyDm };
}

const noPressure: PressureColumns = { length: 0, t: new Uint32Array(0), pascals: new Uint32Array(0) };

/**
 * The phone track with the file heart rate when it had none, and with the file altitudes instead of its own; the phone
 * barometer goes with them, since it would otherwise drive the altitude again (`ELE-002`).
 */
function mergedTrack(phone: Track, computation: ImportComputation, heartRate: boolean, altitudes: FileAltitudes | null): Track {
  const offsetMs = computation.activity.startedAt - phone.startedAt;
  const { samples } = phone;
  return {
    startedAt: phone.startedAt,
    marks: phone.marks,
    samples: {
      fixes: altitudes === null ? samples.fixes : replacedAltitudes(samples.fixes, altitudes, offsetMs),
      pressure: altitudes === null ? samples.pressure : noPressure,
      steps: samples.steps,
      heartRate: heartRate ? shiftedHeartRate(computation.track.samples.heartRate, offsetMs) : samples.heartRate,
      cadence: samples.cadence,
      power: samples.power,
    },
  };
}

/** The completed phone recording of the same sport sharing the most time with the file, when it covers 80 % of both. */
export function findImportMerge(db: ObnixeDatabase, computation: ImportComputation): ImportMerge | null {
  const { activity, summary } = computation;
  const fileStart = activity.startedAt;
  const fileEnd = activity.startedAt + summary.elapsedMs;
  const candidates = db
    .select({ sessionId: session.id, startedAt: session.startedAt, endedAt: session.endedAt, trackFile: recording.trackFile, heartRateSource: recording.heartRateSource })
    .from(session)
    .innerJoin(recording, eq(recording.sessionId, session.id))
    .where(
      and(
        eq(session.sport, computation.sport.sport),
        eq(session.status, "completed"),
        isNull(session.deletedAt),
        eq(recording.source, "live"),
        isNotNull(recording.trackFile),
        lt(session.startedAt, fileEnd as EpochMs),
        gt(session.endedAt, fileStart as EpochMs),
      ),
    )
    .all();
  let best: ImportMerge | null = null;
  let bestOverlap = 0;
  const offersAltitude = fileAltitudes(activity).t.length >= 2;
  const fileHeartRate = computation.track.samples.heartRate.length > 0;
  for (const candidate of candidates) {
    if (candidate.trackFile === null || candidate.endedAt === null) continue;
    const overlap = Math.min(candidate.endedAt, fileEnd) - Math.max(candidate.startedAt, fileStart);
    if (overlap < mergeOverlapRatio * Math.max(candidate.endedAt - candidate.startedAt, fileEnd - fileStart) || overlap <= bestOverlap) continue;
    const addsHeartRate = fileHeartRate && candidate.heartRateSource === "none";
    if (!addsHeartRate && !offersAltitude) continue;
    best = { sessionId: candidate.sessionId, trackFile: candidate.trackFile, addsHeartRate, offersAltitude };
    bestOverlap = overlap;
  }
  return best;
}

/**
 * The « Fusion » changeset (`IO-052`), author `import`: the phone recording moves to a new row and a new `.otrk` holding
 * the added streams, its summary, laps and session values recomputed; the original track file is never rewritten. The
 * recording takes the file's `external_id`, so the same file is then already imported.
 */
export function planImportMerge(db: ObnixeDatabase, env: Environment, draft: ImportMergeDraft): ImportMergePlan {
  const { computation, merge, phoneTrack } = draft;
  const { activity } = computation;
  const heartRate = phoneTrack.samples.heartRate.length === 0 && computation.track.samples.heartRate.length > 0;
  const altitudes = draft.replaceAltitude ? fileAltitudes(activity) : null;
  const replacesAltitude = altitudes !== null && altitudes.t.length >= 2;
  if (!heartRate && !replacesAltitude) throw new NothingToMergeError(merge.sessionId);
  const release = externalIdRelease(db, activity.externalId, null);
  const track = mergedTrack(phoneTrack, computation, heartRate, replacesAltitude ? altitudes : null);
  const bytes = encodeTrack(track);
  const recordingId = env.newId();
  const file: ImportTrackFile = { path: trackFilePath(recordingId), bytes, sha256: trackDigest(bytes) };
  const rewrite = planTrackReplacement(db, env, merge.sessionId, {
    recordingId,
    track,
    stored: { file: file.path, sha256: file.sha256, bytes: bytes.length },
    patch: {
      externalId: activity.externalId,
      ...(heartRate ? { heartRateSource: "file", heartRateDevice: fileDevice(activity) } : {}),
      ...(replacesAltitude ? { elevationSource: "file" } : {}),
    },
  });
  return {
    sessionId: merge.sessionId,
    recordingId,
    track: file,
    request: { actor: importActor, summary: importMergeSummary, revertsId: null, mutations: [...release, ...rewrite.mutations] },
  };
}
