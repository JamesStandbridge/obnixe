import { fixAt } from "./batch.ts";
import type { Track } from "./codec/track.ts";
import type { Sample, TrackerMark } from "./types.ts";

export type TrackFeedItem = { readonly kind: "sample"; readonly sample: Sample } | { readonly kind: "mark"; readonly mark: TrackerMark };

interface Ranked {
  readonly t: number;
  readonly rank: number;
  readonly item: TrackFeedItem;
}

/**
 * The samples and marks of a stored track in time order, as the live tracker takes them. At the same instant the marks come
 * first, then pressure, steps and heart rate before the fix, as `processTrack` settles them: the stream order of the journal
 * is not stored, so this order is the canonical one.
 */
export function trackFeed(track: Pick<Track, "samples" | "marks">): readonly TrackFeedItem[] {
  const { fixes, pressure, steps, heartRate } = track.samples;
  const ranked: Ranked[] = track.marks.map((mark): Ranked => ({ t: mark.t, rank: 0, item: { kind: "mark", mark } }));
  for (let index = 0; index < pressure.length; index += 1) {
    const t = pressure.t[index] ?? 0;
    ranked.push({ t, rank: 1, item: { kind: "sample", sample: { type: "pressure", t, pascals: pressure.pascals[index] ?? 0 } } });
  }
  for (let index = 0; index < steps.length; index += 1) {
    const t = steps.t[index] ?? 0;
    ranked.push({ t, rank: 2, item: { kind: "sample", sample: { type: "steps", t, count: steps.count[index] ?? 0 } } });
  }
  for (let index = 0; index < heartRate.length; index += 1) {
    const t = heartRate.t[index] ?? 0;
    const bpm = heartRate.bpm[index] ?? 0;
    const rrInterval = heartRate.rrInterval[index] ?? null;
    const sample: Sample = { type: "heart_rate", t, bpm, contact: bpm === 0 ? "absent" : "contact", rrInterval: rrInterval === null || rrInterval <= 0 ? null : rrInterval };
    ranked.push({ t, rank: 3, item: { kind: "sample", sample } });
  }
  for (let index = 0; index < fixes.length; index += 1) ranked.push({ t: fixes.t[index] ?? 0, rank: 4, item: { kind: "sample", sample: fixAt(fixes, index) } });
  ranked.sort((left, right) => left.t - right.t || left.rank - right.rank);
  return ranked.map((entry) => entry.item);
}
