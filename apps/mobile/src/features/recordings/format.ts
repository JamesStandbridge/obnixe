import { isAscentEffort } from "@obnixe/core";
import type { RecordingSummary, ResolvedProfile, TrackClimb, TrackDetails } from "@obnixe/core";
import type { BestEffortKey, MetricKey } from "@obnixe/schema";
import { effortLabel } from "@/features/recording/records";
import type { FigureText } from "@/features/stats/format";
import { capitalize } from "@/format/labels";
import { formatLongClock } from "@/format/durations";
import { formatInteger, formatNumber } from "@/format/numbers";
import type { StatValue } from "@/ui/Stats";

export function paceUnit(pacePerMeters: number): string {
  return pacePerMeters === 1000 ? "/km" : `/${formatInteger(pacePerMeters)} m`;
}

/** Seconds per `pacePerMeters`, `null` without distance. */
export function paceSeconds(distanceMm: number, movingMs: number, pacePerMeters: number): number | null {
  return distanceMm <= 0 || movingMs <= 0 ? null : (movingMs / 1000) * ((pacePerMeters * 1000) / distanceMm);
}

export function paceFigure(seconds: number, pacePerMeters: number): FigureText {
  return { value: formatLongClock(seconds), unit: paceUnit(pacePerMeters) };
}

export function speedFigure(metersPerSecond: number): FigureText {
  return { value: formatNumber(metersPerSecond * 3.6, 1, 1), unit: "km/h" };
}

export function distanceText(distanceMm: number): FigureText {
  const kilometers = distanceMm / 1_000_000;
  return { value: formatNumber(kilometers, kilometers >= 100 ? 1 : 2, kilometers >= 100 ? 1 : 2), unit: "km" };
}

export function elapsedText(ms: number): string {
  return formatLongClock(ms / 1000);
}

/** Pace or speed of a stretch in the sport's primary metric. */
export function rateFigure(profile: Pick<ResolvedProfile, "primary" | "pacePerMeters">, distanceMm: number, movingMs: number): FigureText | null {
  switch (profile.primary) {
    case "pace": {
      const seconds = paceSeconds(distanceMm, movingMs, profile.pacePerMeters);
      return seconds === null ? null : paceFigure(seconds, profile.pacePerMeters);
    }
    case "speed":
      return movingMs <= 0 ? null : speedFigure(distanceMm / movingMs);
    default: {
      const unreachable: never = profile.primary;
      return unreachable;
    }
  }
}

export interface SummaryInput {
  readonly profile: ResolvedProfile;
  readonly summary: RecordingSummary;
  readonly details: TrackDetails;
  readonly energyKcal: number | null;
}

const meters = (mm: number | null): FigureText | null => (mm === null ? null : { value: formatInteger(mm / 1000), unit: "m" });

function figure(key: MetricKey, input: SummaryInput): (FigureText & { readonly label: string }) | null {
  const { profile, summary, details } = input;
  const labelled = (label: string, text: FigureText | null): (FigureText & { readonly label: string }) | null => (text === null ? null : { label, ...text });
  switch (key) {
    case "elapsed":
      return labelled("Temps total", { value: elapsedText(summary.elapsedMs), unit: "" });
    case "moving":
      return labelled("En mouvement", { value: elapsedText(summary.movingMs), unit: "" });
    case "distance":
      return labelled("Distance", distanceText(summary.distanceMm));
    case "pace_avg": {
      const seconds = paceSeconds(summary.distanceMm, summary.movingMs, profile.pacePerMeters);
      return labelled("Allure moy.", seconds === null ? null : paceFigure(seconds, profile.pacePerMeters));
    }
    case "gap_avg": {
      const seconds = details.gradeAdjustedDistanceMm === null ? null : paceSeconds(details.gradeAdjustedDistanceMm, summary.movingMs, profile.pacePerMeters);
      return labelled("Allure ajustée", seconds === null ? null : paceFigure(seconds, profile.pacePerMeters));
    }
    case "speed_avg":
      return labelled("Vitesse moy.", summary.movingMs <= 0 ? null : speedFigure(summary.distanceMm / summary.movingMs));
    case "speed_max":
      return labelled("Vitesse max", summary.speedMaxMmS === null ? null : speedFigure(summary.speedMaxMmS / 1000));
    case "ascent":
      return labelled("D+", meters(summary.ascentMm));
    case "descent":
      return labelled("D−", meters(summary.descentMm));
    case "altitude_min":
      return labelled("Alt. min", meters(summary.altitudeMinMm));
    case "altitude_max":
      return labelled("Alt. max", meters(summary.altitudeMaxMm));
    case "vam":
      return labelled("VAM", details.vamMetersPerHour === null ? null : { value: formatInteger(details.vamMetersPerHour), unit: "m/h" });
    case "cadence":
      return labelled("Cadence", summary.cadenceAvg === null ? null : { value: formatInteger(summary.cadenceAvg), unit: "pas/min" });
    case "steps":
      return labelled("Pas", summary.steps === null ? null : { value: formatInteger(summary.steps), unit: "" });
    case "heart_rate_avg":
      return labelled("FC moy.", summary.heartRateAvg === null ? null : { value: formatInteger(summary.heartRateAvg), unit: "bpm" });
    case "heart_rate_max":
      return labelled("FC max", summary.heartRateMax === null ? null : { value: formatInteger(summary.heartRateMax), unit: "bpm" });
    case "energy":
      return labelled("Énergie", input.energyKcal === null ? null : { value: formatInteger(input.energyKcal), unit: "kcal" });
    case "pace_now":
    case "pace_lap":
    case "gap_now":
    case "speed_now":
    case "altitude":
    case "grade_now":
    case "vertical_speed":
    case "heart_rate":
    case "heart_rate_zone":
    case "gps_quality":
    case "clock":
    case "route_remaining":
    case "route_ascent_remaining":
    case "route_progress":
      return null;
    default: {
      const unreachable: never = key;
      return unreachable;
    }
  }
}

export interface SummaryFigure extends StatValue {
  readonly key: MetricKey;
}

/** The grid of the detail (`SUM-001`): the sport's metrics that make sense after the activity, in the profile's order. */
export function summaryFigures(input: SummaryInput): readonly SummaryFigure[] {
  return input.profile.metrics.flatMap((key): SummaryFigure[] => {
    const text = figure(key, input);
    return text === null ? [] : [{ key, label: text.label, value: text.value, unit: text.unit }];
  });
}

/** A best effort as a row or board title: « 10 km », « Semi-marathon », « D+ en 1 h ». */
export function effortTitle(effort: BestEffortKey): string {
  return capitalize(effortLabel(effort));
}

export interface EffortFigureInput {
  readonly effort: BestEffortKey;
  readonly elapsedMs: number;
  readonly ascentMm: number | null;
}

/** The elapsed time of a distance effort (`DEC-05`), the ascent of a one-hour effort. */
export function effortFigure(row: EffortFigureInput): FigureText {
  return isAscentEffort(row.effort) ? { value: formatInteger((row.ascentMm ?? 0) / 1000), unit: "m" } : { value: elapsedText(row.elapsedMs), unit: "" };
}

export interface ClimbText {
  readonly detail: string;
  readonly ascent: string;
  readonly effort: string;
}

function gradeText(grade: number): string {
  return `${formatNumber(grade * 100, 1)} %`;
}

/** `GPS-062`: where the climb starts, its length and grades, its D+, then its moving time and VAM. */
export function climbText(climb: TrackClimb): ClimbText {
  const length = distanceText(climb.distanceMm);
  const vam = climb.vamMetersPerHour === null ? "" : ` · ${formatInteger(climb.vamMetersPerHour)} m/h`;
  return {
    detail: `Au km ${formatNumber(climb.startDistanceMm / 1_000_000, 1)} · ${length.value} ${length.unit} à ${gradeText(climb.gradeAvg)} · max ${gradeText(climb.gradeMax)}`,
    ascent: `+${formatInteger(climb.ascentMm / 1000)} m`,
    effort: `${elapsedText(climb.movingMs)}${vam}`,
  };
}
