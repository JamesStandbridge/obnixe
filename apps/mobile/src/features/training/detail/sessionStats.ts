import { activeSeconds, estimatedOneRepMax, gramsToMass, totalLoadGrams } from "@obnixe/core";
import type { ExerciseLoad, SessionReport } from "@obnixe/core";
import { sports } from "@obnixe/schema";
import type { EpochMs, MassUnit, StrengthSet } from "@obnixe/schema";
import { durationFigure } from "@/features/stats/format";
import { capitalize } from "@/format/labels";
import { formatClock, formatLongClock } from "@/format/durations";
import { formatNumber } from "@/format/numbers";
import { climbItemWord, indicatorFigure, quantityFigure } from "@/features/training/sessionText";
import type { StatValue } from "@/ui/Stats";

export interface HeroStats {
  readonly primary: readonly StatValue[];
  readonly secondary: readonly StatValue[];
  readonly shownFields: ReadonlySet<string>;
}

const shortFieldLabels: Readonly<Record<string, string>> = {
  elevation_gain: "Dénivelé +",
  heart_rate_avg: "FC moyenne",
  power_avg: "Puissance",
  pack_mass: "Sac",
};

const maxSecondary = 3;

function durationStat(seconds: number): StatValue {
  const figure = durationFigure(seconds);
  return { label: "Durée", value: figure.value, unit: figure.unit };
}

export function heroStats(report: SessionReport, now: EpochMs, unit: MassUnit): HeroStats {
  const { session } = report.data;
  const sport = sports[session.sport];
  if (report.climb !== null) {
    const word = climbItemWord(session);
    return {
      primary: [
        { label: capitalize(word.plural), value: String(report.climb.count), unit: "" },
        { label: "Max enchaîné", value: report.climb.maxSent ?? "–", unit: "" },
        { label: "Flashs", value: String(report.climb.flash), unit: "" },
      ],
      secondary: [durationStat(activeSeconds(session, now)), { label: "Enchaînés", value: String(report.climb.sent), unit: `/ ${report.climb.count}` }],
      shownFields: new Set(),
    };
  }
  if (sport.archetype === "strength") {
    const { summary } = report;
    const primary: StatValue[] = [durationStat(summary.durationSeconds), { label: "Séries", value: String(summary.setsDone), unit: summary.setsPlanned === null ? "" : `/ ${summary.setsPlanned}` }];
    if (summary.volumeGrams > 0) primary.push({ label: "Volume", value: formatNumber(gramsToMass(summary.volumeGrams, unit), 0), unit });
    const secondary: StatValue[] = [{ label: "Exercices", value: String(report.exercises.length), unit: "" }];
    const topLoad = Math.max(0, ...report.exercises.flatMap((entry) => entry.exercise.sets.filter((set) => !set.interrupted).map((set) => totalLoadGrams(set.loadGrams, entry.exercise.exercise) ?? 0)));
    if (topLoad > 0) secondary.push({ label: "Charge max", value: formatNumber(gramsToMass(topLoad, unit)), unit });
    if (summary.averageRestSeconds !== null) secondary.push({ label: "Repos moyen", value: formatClock(summary.averageRestSeconds), unit: "" });
    return { primary, secondary, shownFields: new Set() };
  }
  const seconds = activeSeconds(session, now);
  const shownFields = new Set<string>();
  const primary: StatValue[] = [];
  const distance = session.values.distance;
  if (typeof distance === "number" && distance > 0) {
    const figure = quantityFigure("distance", distance, "distance", unit);
    primary.push({ label: "Distance", value: figure.text, unit: figure.unit });
    shownFields.add("distance");
  }
  primary.push({ label: "Durée", value: formatLongClock(seconds), unit: "" });
  for (const indicator of sport.indicators) {
    const figure = indicatorFigure(indicator, session.values, seconds);
    if (figure !== null) primary.push({ label: indicator.label, value: figure.text, unit: figure.unit });
  }
  const secondary: StatValue[] = [];
  for (const field of sport.sessionFields) {
    const value = session.values[field.key];
    if (field.type !== "quantity" || field.key === "distance" || typeof value !== "number" || secondary.length === maxSecondary) continue;
    const figure = quantityFigure(field.key, value, field.dimension, unit);
    secondary.push({ label: shortFieldLabels[field.key] ?? field.label, value: figure.text, unit: figure.unit });
    shownFields.add(field.key);
  }
  return { primary, secondary, shownFields };
}

function setScore(set: StrengthSet, load: ExerciseLoad): number {
  const total = totalLoadGrams(set.loadGrams, load);
  if (total !== null && total > 0 && set.reps !== null) return estimatedOneRepMax(total, set.reps);
  if (set.durationSeconds !== null) return set.durationSeconds;
  return set.reps ?? 0;
}

/** Relative strength of each set, 0 for interrupted ones. */
export function setScores(sets: readonly StrengthSet[], load: ExerciseLoad): readonly number[] {
  return sets.map((set) => (set.interrupted ? 0 : setScore(set, load)));
}

/** Index of the first strongest completed set, or null when fewer than two sets were completed. */
export function bestSetIndex(sets: readonly StrengthSet[], load: ExerciseLoad): number | null {
  const scores = setScores(sets, load);
  if (sets.filter((set) => !set.interrupted).length < 2) return null;
  let best: number | null = null;
  let bestScore = 0;
  for (const [index, score] of scores.entries()) {
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  }
  return best;
}
