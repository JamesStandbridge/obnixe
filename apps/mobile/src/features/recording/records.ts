import type { RecordAnnouncement } from "@obnixe/core";
import type { BestEffortKey } from "@obnixe/schema";
import { formatLongClock } from "@/format/durations";
import { formatInteger, formatNumber } from "@/format/numbers";

export interface RecordLine {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly record: boolean;
}

const races: ReadonlyMap<number, string> = new Map([
  [21097.5, "semi-marathon"],
  [42195, "marathon"],
]);

function distanceOf(effort: BestEffortKey): number | null {
  const [, kind, meters] = effort.split(":");
  return kind === "distance" ? Number(meters) : null;
}

/** « 10 km », « 400 m », « 1 mile », « semi-marathon »; « D+ en 1 h » for the ascent window. */
export function effortLabel(effort: BestEffortKey): string {
  const meters = distanceOf(effort);
  if (meters === null) return "D+ en 1 h";
  if (meters === 1609.344) return "1 mile";
  const race = races.get(meters);
  if (race !== undefined) return race;
  return meters < 1000 ? `${formatInteger(meters)} m` : `${formatNumber(meters / 1000, 1)} km`;
}

/** « sur 10 km », « au marathon ». */
function onEffort(effort: BestEffortKey): string {
  const meters = distanceOf(effort);
  return meters !== null && races.has(meters) ? `au ${effortLabel(effort)}` : `sur ${effortLabel(effort)}`;
}

function resultText(announcement: Pick<RecordAnnouncement, "elapsedMs" | "ascentMm">): string {
  return announcement.ascentMm === null ? formatLongClock(announcement.elapsedMs / 1000) : `${formatInteger(announcement.ascentMm / 1000)} m`;
}

function gapText(announcement: RecordAnnouncement): string | null {
  const best = announcement.best;
  if (best === null) return null;
  if (announcement.ascentMm !== null) {
    const meters = Math.round((announcement.ascentMm - (best.ascentMm ?? 0)) / 1000);
    return meters === 0 ? null : `${meters > 0 ? "+" : "−"}${formatInteger(Math.abs(meters))} m`;
  }
  const seconds = Math.round((announcement.elapsedMs - best.elapsedMs) / 1000);
  return seconds === 0 ? null : `${seconds > 0 ? "+" : "−"}${formatLongClock(Math.abs(seconds))}`;
}

function titleOf(announcement: RecordAnnouncement): string {
  const ascent = distanceOf(announcement.effort) === null;
  if (announcement.rank === 1) return ascent ? "Record de D+ en 1 h" : `Record ${onEffort(announcement.effort)}`;
  return ascent ? `${announcement.rank}e meilleur D+ en 1 h` : `${announcement.rank}e meilleur temps ${onEffort(announcement.effort)}`;
}

/**
 * `PR-004`: « Record sur 10 km : 44:12, −0:38 », then the second and third best results with the gap to the record. First
 * efforts of a kind make one line, so a first activity is not a list of records.
 */
export function recordLines(announcements: readonly RecordAnnouncement[]): readonly RecordLine[] {
  const firsts = announcements.filter((announcement) => announcement.best === null);
  const ranked = announcements
    .filter((announcement) => announcement.best !== null)
    .map((announcement): RecordLine => {
      const gap = gapText(announcement);
      return { key: announcement.effort, title: titleOf(announcement), detail: gap === null ? resultText(announcement) : `${resultText(announcement)}, ${gap}`, record: announcement.rank === 1 };
    });
  if (firsts.length === 0) return ranked;
  const first: RecordLine = {
    key: "firsts",
    title: firsts.length === 1 ? "Premier temps de référence" : "Premiers temps de référence",
    detail: firsts.map((announcement) => `${effortLabel(announcement.effort)} ${resultText(announcement)}`).join(" · "),
    record: false,
  };
  return [...ranked, first];
}
