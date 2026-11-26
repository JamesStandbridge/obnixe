import type { SegmentTrend } from "@obnixe/core";
import type { Segment } from "@obnixe/schema";
import { distanceText } from "@/features/recordings/format";
import { formatInteger } from "@/format/numbers";

/** The badge of an effort: the best one, or its place when there are several (`SEG-003`). */
export function segmentRankLabel(rank: number, count: number): string | null {
  if (count < 2) return null;
  return rank === 1 ? "Record" : `${rank}e sur ${count}`;
}

export function segmentTrendText(trend: SegmentTrend | null): string {
  switch (trend) {
    case "faster":
      return "En progrès";
    case "steady":
      return "Stable";
    case "slower":
      return "En retrait";
    case null:
      return "–";
    default: {
      const unreachable: never = trend;
      return unreachable;
    }
  }
}

/** Distance, and D+ when it climbs. */
export function segmentMeasureText(segment: Pick<Segment, "distanceMm" | "ascentMm">): string {
  const distance = distanceText(segment.distanceMm);
  const ascent = Math.round(segment.ascentMm / 1000);
  return ascent > 0 ? `${distance.value} km · D+ ${formatInteger(ascent)} m` : `${distance.value} km`;
}
