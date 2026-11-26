import { Platform } from "react-native";
import { encodeJournalBatch, encodeJournalHeader, readJournal } from "@obnixe/core";
import type { JournalContents, TrackerMarkKind } from "@obnixe/core";
import type { EpochMs, Id } from "@obnixe/schema";
import { appendJournal, readJournalFileSync, readStopwatchMarker, replaceJournal, writeStopwatchMarker } from "@/features/tracking/trackStore";
import type { TrackerPort } from "@/features/tracking/recorderHost";
import type { TrackerErrorCode, TrackerEvents, TrackerStartRequest, TrackerStarted, TrackerStatus, TrackerStopped } from "../../../modules/obnixe-tracker";

type Listeners = { [Name in keyof TrackerEvents]: Set<TrackerEvents[Name]> };

export class StopwatchTrackerError extends Error {
  constructor(readonly code: TrackerErrorCode) {
    super(code);
  }
}

interface Running {
  readonly sessionId: Id;
  readonly startedAt: EpochMs;
  sequence: number;
  paused: boolean;
  lastT: number;
}

const idle: TrackerStatus = { state: "idle", sessionId: null };

function pausedAtEnd(contents: JournalContents): boolean {
  let paused = false;
  for (const mark of contents.marks) if (mark.kind !== "lap") paused = mark.kind === "pause" || mark.kind === "stop";
  return paused;
}

function lastTOf(contents: JournalContents): number {
  return Math.max(contents.marks.at(-1)?.t ?? 0, contents.samples.at(-1)?.t ?? 0);
}

/** Reads the journal back and drops a torn last batch, so the next one follows the last valid one. */
function openJournal(sessionId: Id): JournalContents | null {
  const bytes = readJournalFileSync(sessionId);
  if (bytes === null) return null;
  const contents = readJournal(bytes);
  if (contents.header !== null && contents.validLength < bytes.length) replaceJournal(sessionId, bytes.slice(0, contents.validLength));
  return contents;
}

/**
 * `REC-060`: the tracker of a stopwatch recording without a heart-rate source, for which the native module has nothing to
 * measure. Its journal holds the marks only, in the native format, so the host reads it like any other. Times come from the
 * wall clock: the stopwatch keeps running while the app is suspended or killed, and a restart picks the journal back up
 * from the marker kept next to it.
 */
export class StopwatchTracker implements TrackerPort {
  private readonly listeners: Listeners = { onSamples: new Set(), onMark: new Set(), onIssue: new Set(), onSensorDevice: new Set(), onWarmupFix: new Set() };
  private running: Running | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  addListener<Name extends keyof TrackerEvents>(name: Name, listener: TrackerEvents[Name]): { remove: () => void } {
    const set = this.listeners[name] as Set<TrackerEvents[Name]>;
    set.add(listener);
    return { remove: () => set.delete(listener) };
  }

  status(): TrackerStatus {
    const running = this.current();
    return running === null ? idle : { state: "recording", sessionId: running.sessionId };
  }

  async prepare(): Promise<void> {}

  cancelPreparation(): void {}

  async start(request: TrackerStartRequest): Promise<TrackerStarted> {
    if (this.current() !== null) throw new StopwatchTrackerError("ERR_TRACKER_RUNNING");
    const sessionId = request.sessionId as Id;
    if (request.journal === "create") {
      const startedAt = this.now() as EpochMs;
      appendJournal(sessionId, encodeJournalHeader({ sessionId, startedAt, monotonicOriginNs: 0n, platform: Platform.OS === "android" ? "android" : "ios", device: Platform.OS === "android" ? "Android" : "iPhone" }));
      this.running = { sessionId, startedAt, sequence: 0, paused: false, lastT: 0 };
      this.write(this.running, "start", 0);
    } else {
      const contents = openJournal(sessionId);
      if (contents?.header == null) throw new StopwatchTrackerError("ERR_TRACKER_JOURNAL");
      const running: Running = { sessionId, startedAt: contents.header.startedAt, sequence: (contents.lastSequence ?? -1) + 1, paused: false, lastT: lastTOf(contents) };
      this.running = running;
      if (contents.marks.at(-1)?.kind !== "stop") this.write(running, "stop", running.lastT);
      this.write(running, "start", this.elapsed(running));
    }
    writeStopwatchMarker(sessionId);
    return { startedAt: this.running.startedAt, sources: { location: null, barometer: false, pedometer: false, heartRate: false, cadence: false, power: false } };
  }

  mark(kind: "pause" | "resume" | "lap"): void {
    const running = this.current();
    if (running === null || (kind === "resume") !== running.paused) return;
    if (kind !== "lap") running.paused = kind === "pause";
    this.write(running, kind, this.elapsed(running));
  }

  setPower(): void {}

  setNotification(): void {}

  async stop(): Promise<TrackerStopped> {
    const running = this.current();
    if (running === null) throw new StopwatchTrackerError("ERR_TRACKER_NOT_RECORDING");
    this.write(running, "stop", this.elapsed(running));
    this.running = null;
    writeStopwatchMarker(null);
    return { sessionId: running.sessionId, endedAt: (running.startedAt + running.lastT) as EpochMs, lastSequence: running.sequence - 1 };
  }

  private current(): Running | null {
    if (this.running !== null) return this.running;
    const sessionId = readStopwatchMarker();
    if (sessionId === null) return null;
    const contents = openJournal(sessionId);
    if (contents?.header == null || contents.marks.at(-1)?.kind === "stop") {
      writeStopwatchMarker(null);
      return null;
    }
    this.running = { sessionId, startedAt: contents.header.startedAt, sequence: (contents.lastSequence ?? -1) + 1, paused: pausedAtEnd(contents), lastT: lastTOf(contents) };
    return this.running;
  }

  private elapsed(running: Running): number {
    return Math.max(running.lastT, this.now() - running.startedAt);
  }

  private write(running: Running, kind: TrackerMarkKind, t: number): void {
    const sequence = running.sequence;
    appendJournal(running.sessionId, encodeJournalBatch(sequence, [{ type: "mark", kind, t }]));
    running.sequence += 1;
    running.lastT = Math.max(running.lastT, t);
    for (const listener of this.listeners.onSamples) listener({ sessionId: running.sessionId, sequence, offset: 0, samples: [], end: true });
    for (const listener of this.listeners.onMark) listener({ sessionId: running.sessionId, sequence, kind, t });
  }
}
