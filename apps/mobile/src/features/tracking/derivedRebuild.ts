import {
  TrackDecodeError,
  activePrivacyMask,
  clearSegmentEfforts,
  decodeTrack,
  derivationBatchSize,
  markSegmentsSwept,
  previewMutationOf,
  profileOfSession,
  reprocessRecording,
  segmentShape,
  segmentSweepCandidates,
  staleDerivationCount,
  staleDerivations,
  staleSegments,
  storeDerivation,
  storeSweptEfforts,
} from "@obnixe/core";
import type { Mutation, PrivacyMask, ProcessedTrack, StaleDerivation, Track } from "@obnixe/core";
import type { Id } from "@obnixe/schema";
import { db } from "@/data/database";
import type { RecorderWriter } from "@/features/tracking/recorderHost";
import { readTrack } from "@/features/tracking/trackStore";

export interface DerivedRebuildState {
  /** Recordings whose records or masked preview are not current: the records screen shows « Calcul des records… » (`DAT-012`). */
  readonly pending: number;
  /** Segments searched over the whole history: the activity detail shows « Recherche des passages… » (`SEG-003`). */
  readonly segments: number;
  readonly running: boolean;
}

interface Rebuilt {
  readonly stale: StaleDerivation;
  readonly track: Track;
  readonly processed: ProcessedTrack;
}

const nextTick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

const idle: DerivedRebuildState = { pending: 0, segments: 0, running: false };

/**
 * Keeps `best_effort`, `segment_effort` and the masked previews current (`DAT-012`, `PR-003`, `PRV-010`) in batches of 20
 * recordings: after a migration or an algorithm change, a trim undo, a sport edit, an import, or a change of the privacy zones
 * or of the hidden track ends. Previews of a batch are rewritten in one journaled commit before their derivation is recorded.
 * Then a new or redrawn segment is searched over every recording that may pass it, also by batches of 20 (`SEG-003`).
 */
export class DerivedRebuild {
  private readonly listeners = new Set<() => void>();
  private state: DerivedRebuildState = idle;
  private again = false;
  private current: Promise<void> | null = null;

  constructor(
    private readonly writer: Pick<RecorderWriter, "write">,
    private readonly report: (error: unknown) => void,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): DerivedRebuildState => this.state;

  /** Starts a pass, or queues one after the running pass so a change made meanwhile is seen. */
  request(): Promise<void> {
    if (this.current !== null) {
      this.again = true;
      return this.current;
    }
    this.current = this.loop()
      .catch(this.report)
      .finally(() => {
        this.current = null;
      });
    return this.current;
  }

  private async loop(): Promise<void> {
    do {
      this.again = false;
      await this.pass();
    } while (this.again);
  }

  private async pass(): Promise<void> {
    const skipped = new Set<Id>();
    const segments = staleSegments(db()).length;
    for (;;) {
      const mask = activePrivacyMask(db());
      const pending = staleDerivationCount(db(), mask) - skipped.size;
      this.set({ pending: Math.max(0, pending), segments, running: pending > 0 || segments > 0 });
      if (pending <= 0) break;
      const batch = staleDerivations(db(), mask, derivationBatchSize + skipped.size).filter((stale) => !skipped.has(stale.session.id)).slice(0, derivationBatchSize);
      if (batch.length === 0) break;
      const rebuilt: Rebuilt[] = [];
      for (const stale of batch) {
        const result = await this.rebuild(stale);
        if (result === null) skipped.add(stale.session.id);
        else rebuilt.push(result);
      }
      this.store(rebuilt, mask);
      await nextTick();
    }
    await this.sweep();
  }

  /** Sessions saved meanwhile are matched by their own derivation; a segment redrawn meanwhile stays stale for the next pass. */
  private async sweep(): Promise<void> {
    const stale = staleSegments(db());
    this.set({ pending: 0, segments: stale.length, running: stale.length > 0 });
    if (stale.length === 0) return;
    const shapes = stale.map(segmentShape);
    clearSegmentEfforts(
      db(),
      stale.map((row) => row.id),
    );
    const candidates = segmentSweepCandidates(db(), shapes);
    for (let index = 0; index < candidates.length; index += derivationBatchSize) {
      for (const candidate of candidates.slice(index, index + derivationBatchSize)) {
        const rebuilt = await this.rebuild(candidate);
        if (rebuilt !== null) storeSweptEfforts(db(), candidate.session.id, rebuilt.processed, shapes);
      }
      await nextTick();
    }
    markSegmentsSwept(db(), stale);
    this.set(idle);
  }

  /** A missing or unreadable track is shown « Trace indisponible » by the detail and keeps its last derived rows. */
  private async rebuild(stale: StaleDerivation): Promise<Rebuilt | null> {
    const file = stale.recording.trackFile;
    const bytes = file === null ? null : await readTrack(file);
    if (bytes === null) return null;
    let track: Track;
    try {
      track = decodeTrack(bytes);
    } catch (error) {
      if (error instanceof TrackDecodeError) return null;
      throw error;
    }
    const processed = reprocessRecording(db(), stale, track, { startMs: stale.recording.trimStartMs, endMs: stale.recording.trimEndMs }, profileOfSession(stale.session));
    return { stale, track, processed };
  }

  private store(rebuilt: readonly Rebuilt[], mask: PrivacyMask): void {
    const previews = rebuilt.flatMap((item): Mutation[] => {
      const mutation = previewMutationOf(item.stale.recording, item.processed, mask);
      return mutation === null ? [] : [mutation];
    });
    if (previews.length > 0) this.writer.write("Aperçus de trace recalculés", previews);
    for (const item of rebuilt) storeDerivation(db(), item.stale.session.id, item.track, item.processed, mask);
  }

  private set(state: DerivedRebuildState): void {
    if (state.pending === this.state.pending && state.segments === this.state.segments && state.running === this.state.running) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
