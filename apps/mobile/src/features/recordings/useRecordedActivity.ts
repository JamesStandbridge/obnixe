import { useEffect, useState } from "react";
import { analyzeRecording, decodeTrack, heartRateZoneReport, NotRecordableError, profileOfSession, TrackDecodeError } from "@obnixe/core";
import type { HeartRateZoneReport, PrivacyMask, ProcessedTrack, ResolvedProfile, SessionRecording, Track } from "@obnixe/core";
import { db } from "@/data/database";
import { readTrack } from "@/features/tracking/trackStore";

/** What the detail measured from the stored track, at its trim and laps (`SUM-001`). */
export interface RecordedActivity {
  readonly saved: SessionRecording;
  readonly profile: ResolvedProfile;
  readonly track: Track;
  readonly processed: ProcessedTrack;
  readonly zones: HeartRateZoneReport | null;
  /** The privacy mask when the detail hides the zones too (`Q-18`). */
  readonly mask: PrivacyMask | null;
}

/** « Trace indisponible »: the file is gone, or it cannot be read; the stored summary still shows. */
export type TrackUnavailable = "missing" | "damaged" | "not_recordable";

export type RecordedActivityState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable"; readonly reason: TrackUnavailable }
  | { readonly status: "ready"; readonly activity: RecordedActivity };

type TrackRead = { readonly kind: "read"; readonly track: Track } | { readonly kind: "missing" } | { readonly kind: "damaged" };

/** The last track read, so an edit that rewrites the summary measures again without reading the file again. */
let lastRead: { readonly file: string; readonly sha256: string; readonly read: TrackRead } | null = null;

async function loadTrack(file: string, sha256: string): Promise<TrackRead> {
  if (lastRead !== null && lastRead.file === file && lastRead.sha256 === sha256) return lastRead.read;
  const bytes = await readTrack(file);
  let read: TrackRead;
  if (bytes === null) read = { kind: "missing" };
  else {
    try {
      read = { kind: "read", track: decodeTrack(bytes) };
    } catch (error) {
      if (!(error instanceof TrackDecodeError)) throw error;
      read = { kind: "damaged" };
    }
  }
  lastRead = { file, sha256, read };
  return read;
}

function analyze(saved: SessionRecording, track: Track, mask: PrivacyMask | null): RecordedActivityState {
  let profile: ResolvedProfile;
  try {
    profile = profileOfSession(saved.session);
  } catch (error) {
    if (error instanceof NotRecordableError) return { status: "unavailable", reason: "not_recordable" };
    throw error;
  }
  const processed = analyzeRecording(db(), saved, profile, track);
  const zones = heartRateZoneReport(db(), saved.session.startedAt, track.samples.heartRate, processed.moving);
  return { status: "ready", activity: { saved, profile, track, processed, zones, mask } };
}

/**
 * Reads and measures the stored track once per change of the session, the recording or the in-app mask; `revision` names
 * that state, so a change elsewhere in the database does not measure the track again.
 */
export function useRecordedActivity(saved: SessionRecording, mask: PrivacyMask | null, revision: string): RecordedActivityState {
  const [state, setState] = useState<RecordedActivityState>({ status: "loading" });
  const file = saved.recording.trackFile;
  const sha256 = saved.recording.trackSha256;

  useEffect(() => {
    let active = true;
    if (file === null || sha256 === null) {
      setState({ status: "unavailable", reason: "missing" });
      return;
    }
    loadTrack(file, sha256).then(
      (read) => {
        if (!active) return;
        setState(read.kind === "read" ? analyze(saved, read.track, mask) : { status: "unavailable", reason: read.kind });
      },
      (error: unknown) => {
        if (active) setState({ status: "unavailable", reason: "missing" });
        ErrorUtils.getGlobalHandler()(error, false);
      },
    );
    return () => {
      active = false;
    };
  }, [file, sha256, revision]);

  return state;
}
