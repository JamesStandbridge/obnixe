import { readJournal, toSampleColumns } from "@obnixe/core";
import type { JournalContents, JournalHeader, Sample, Track, TrackerMark } from "@obnixe/core";

export type FeedItem = { readonly kind: "sample"; readonly sample: Sample } | { readonly kind: "mark"; readonly mark: TrackerMark };

/** Samples and marks in journal order, each mark before the samples of the same instant, as the live tracker expects. */
export function feedOf(samples: readonly Sample[], marks: readonly TrackerMark[]): readonly FeedItem[] {
  const items: FeedItem[] = [];
  let next = 0;
  for (const sample of samples) {
    for (; next < marks.length && (marks[next]?.t ?? 0) <= sample.t; next += 1) items.push({ kind: "mark", mark: marks[next] as TrackerMark });
    items.push({ kind: "sample", sample });
  }
  for (; next < marks.length; next += 1) items.push({ kind: "mark", mark: marks[next] as TrackerMark });
  return items;
}

/** Latest `t` of a sample or a mark, 0 for an empty journal (`REC-081`). */
export function lastInstantOf(contents: Pick<JournalContents, "samples" | "marks">): number {
  let last = 0;
  for (const sample of contents.samples) last = Math.max(last, sample.t);
  for (const mark of contents.marks) last = Math.max(last, mark.t);
  return last;
}

export interface JournalTrack {
  readonly header: JournalHeader | null;
  readonly track: Track;
  readonly lastT: number;
}

/** The raw journal as a track; a journal whose header never completed gives an empty track starting at `fallbackStartedAt`. */
export function journalTrackOf(bytes: Uint8Array | null, fallbackStartedAt: Track["startedAt"]): JournalTrack {
  const contents = bytes === null ? null : readJournal(bytes);
  const samples = contents?.samples ?? [];
  const marks = contents?.marks ?? [];
  return {
    header: contents?.header ?? null,
    track: { startedAt: contents?.header?.startedAt ?? fallbackStartedAt, samples: toSampleColumns(samples), marks },
    lastT: lastInstantOf({ samples, marks }),
  };
}
