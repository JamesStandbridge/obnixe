import type { LiveLap, LiveMetrics, RecordingSummary, ResolvedProfile, WorkoutRemaining, WorkoutView } from "@obnixe/core";
import type { EpochMs, MetricKey } from "@obnixe/schema";
import { formatTimeAt } from "@/format/dates";
import { formatClock, formatLongClock } from "@/format/durations";
import { formatInteger, formatNumber, formatSigned } from "@/format/numbers";
import type { StatValue } from "@/ui/Stats";

export interface MetricText {
  readonly value: string;
  readonly unit: string;
}

/** Short captions of the live tiles. */
export const metricCaptions: Readonly<Record<MetricKey, string>> = {
  elapsed: "Temps total",
  moving: "Temps",
  distance: "Distance",
  pace_avg: "Allure moy.",
  pace_now: "Allure",
  pace_lap: "Allure tour",
  gap_avg: "GAP moy.",
  gap_now: "GAP",
  speed_avg: "Vitesse moy.",
  speed_now: "Vitesse",
  speed_max: "Vitesse max",
  ascent: "D+",
  descent: "D−",
  altitude: "Altitude",
  altitude_min: "Alt. min",
  altitude_max: "Alt. max",
  grade_now: "Pente",
  vam: "VAM",
  vertical_speed: "Vit. verticale",
  cadence: "Cadence",
  steps: "Pas",
  heart_rate: "FC",
  heart_rate_avg: "FC moy.",
  heart_rate_max: "FC max",
  heart_rate_zone: "Zone FC",
  power: "Puissance",
  power_avg: "Puiss. moy.",
  energy: "Énergie",
  gps_quality: "Précision GPS",
  clock: "Heure",
  workout_step: "Étape",
  route_remaining: "Restant",
  route_ascent_remaining: "D+ restant",
  route_progress: "Progression",
};

/** Full names, for choosing the metrics of the live screen. */
export const metricNames: Readonly<Record<MetricKey, string>> = {
  elapsed: "Temps écoulé",
  moving: "Temps en mouvement",
  distance: "Distance",
  pace_avg: "Allure moyenne",
  pace_now: "Allure instantanée",
  pace_lap: "Allure du tour",
  gap_avg: "Allure ajustée à la pente, moyenne",
  gap_now: "Allure ajustée à la pente",
  speed_avg: "Vitesse moyenne",
  speed_now: "Vitesse instantanée",
  speed_max: "Vitesse maximale",
  ascent: "Dénivelé positif",
  descent: "Dénivelé négatif",
  altitude: "Altitude",
  altitude_min: "Altitude minimale",
  altitude_max: "Altitude maximale",
  grade_now: "Pente",
  vam: "Vitesse ascensionnelle (VAM)",
  vertical_speed: "Vitesse verticale",
  cadence: "Cadence",
  steps: "Pas",
  heart_rate: "Fréquence cardiaque",
  heart_rate_avg: "Fréquence cardiaque moyenne",
  heart_rate_max: "Fréquence cardiaque maximale",
  heart_rate_zone: "Zone cardiaque",
  power: "Puissance",
  power_avg: "Puissance moyenne",
  energy: "Énergie",
  gps_quality: "Précision GPS",
  clock: "Heure",
  workout_step: "Étape de la séance guidée",
  route_remaining: "Distance restante de l'itinéraire",
  route_ascent_remaining: "D+ restant de l'itinéraire",
  route_progress: "Progression sur l'itinéraire",
};

const missingClock = "–:––";
const missing = "–";

export function paceUnit(profile: Pick<ResolvedProfile, "pacePerMeters">): string {
  return profile.pacePerMeters === 100 ? "/100 m" : "/km";
}

/** Steps on foot, pedal revolutions on the bike (`SPT-008`). */
export function cadenceUnit(profile: Pick<ResolvedProfile, "cadence">): string {
  return profile.cadence === "steps" ? "pas/min" : "tr/min";
}

export function formatDistance(meters: number): MetricText {
  if (meters < 1000) return { value: formatInteger(Math.floor(meters)), unit: "m" };
  return { value: formatNumber(Math.floor(meters / 10) / 100, 2, 2), unit: "km" };
}

/** The distance left on a route, to the 100 m past a kilometer: « 7,4 km » (`RTE-003`). */
export function formatRemaining(meters: number): MetricText {
  if (meters < 1000) return { value: formatInteger(Math.round(meters / 10) * 10), unit: "m" };
  return { value: formatNumber(meters / 1000, 1, 1), unit: "km" };
}

export function formatSpeed(metersPerSecond: number): string {
  return formatNumber(metersPerSecond * 3.6, 1, 1);
}

/** Seconds per `pacePerMeters` over a stretch; null below 10 m, where a pace means nothing. */
export function paceOf(movingMs: number, distanceMeters: number, pacePerMeters: number): number | null {
  if (distanceMeters < 10 || movingMs <= 0) return null;
  return movingMs / 1000 / (distanceMeters / pacePerMeters);
}

/**
 * `SPT-006`: one live value in French units, from the units of `LiveMetrics`. `clock` reads `now` in the device time zone;
 * `energy` has no live value and `workout_step` reads the workout (`workoutStepText`).
 */
export function metricText(key: MetricKey, metrics: LiveMetrics, profile: Pick<ResolvedProfile, "pacePerMeters" | "cadence">, now: EpochMs, timeZone: string): MetricText {
  const value = metrics[key];
  switch (key) {
    case "elapsed":
    case "moving":
      return { value: formatLongClock((value ?? 0) / 1000), unit: "" };
    case "distance":
      return formatDistance(value ?? 0);
    case "pace_avg":
    case "pace_now":
    case "pace_lap":
    case "gap_avg":
    case "gap_now":
      return { value: value === undefined ? missingClock : formatClock(value), unit: paceUnit(profile) };
    case "speed_avg":
    case "speed_now":
    case "speed_max":
      return { value: value === undefined ? missing : formatSpeed(value), unit: "km/h" };
    case "ascent":
    case "descent":
    case "altitude":
    case "altitude_min":
    case "altitude_max":
      return { value: value === undefined ? missing : formatInteger(value), unit: "m" };
    case "grade_now":
      return { value: value === undefined ? missing : formatSigned(value * 100, 0), unit: "%" };
    case "vam":
      return { value: value === undefined ? missing : formatInteger(value), unit: "m/h" };
    case "vertical_speed":
      return { value: value === undefined ? missing : formatSigned(value * 3600, 0), unit: "m/h" };
    case "cadence":
      return { value: value === undefined ? missing : formatInteger(value), unit: cadenceUnit(profile) };
    case "steps":
      return { value: value === undefined ? missing : formatInteger(value), unit: "" };
    case "heart_rate":
    case "heart_rate_avg":
    case "heart_rate_max":
      return { value: value === undefined ? missing : formatInteger(value), unit: "bpm" };
    case "heart_rate_zone":
      return { value: value === undefined ? missing : `Z${value}`, unit: "" };
    case "power":
    case "power_avg":
      return { value: value === undefined ? missing : formatInteger(value), unit: "W" };
    case "energy":
      return { value: missing, unit: "kcal" };
    case "workout_step":
      return { value: missing, unit: "" };
    case "gps_quality":
      return { value: value === undefined ? missing : `±${formatInteger(value)}`, unit: "m" };
    case "clock":
      return { value: formatTimeAt(now, timeZone), unit: "" };
    case "route_remaining":
      return value === undefined ? { value: missing, unit: "km" } : formatRemaining(value);
    case "route_ascent_remaining":
      return { value: value === undefined ? missing : formatInteger(value), unit: "m" };
    case "route_progress":
      return { value: value === undefined ? missing : formatInteger(Math.floor(value * 100)), unit: "%" };
    default: {
      const unreachable: never = key;
      return unreachable;
    }
  }
}

/** What remains of the current step, its elapsed time for an open one. */
export function workoutRemainingText(remaining: WorkoutRemaining | null, elapsedMs: number): MetricText {
  if (remaining === null) return { value: missing, unit: "" };
  switch (remaining.kind) {
    case "time":
      return { value: formatLongClock(Math.ceil(remaining.ms / 1000)), unit: "" };
    case "distance":
      return remaining.mm < 1_000_000 ? { value: formatNumber(remaining.mm / 1000, 0), unit: "m" } : { value: formatNumber(remaining.mm / 1_000_000, 2), unit: "km" };
    case "open":
      return { value: formatLongClock(elapsedMs / 1000), unit: "" };
    default: {
      const unreachable: never = remaining;
      return unreachable;
    }
  }
}

/** The `workout_step` metric: rank, then what remains of the step, « 3/8 · 1:12 ». */
export function workoutStepText(workout: WorkoutView): MetricText {
  const { current } = workout;
  if (current === null) return { value: "Terminée", unit: "" };
  const remaining = workoutRemainingText(workout.remaining, workout.stepElapsedMs);
  return { value: `${current.index + 1}/${workout.steps.length} · ${remaining.value}`, unit: remaining.unit };
}

export interface LapFigures {
  readonly title: string;
  readonly duration: string;
  readonly distance: MetricText;
  /** Pace or speed, after the sport's primary measure. */
  readonly rate: MetricText;
}

/** `REC-040`: number, duration, distance and pace or speed of a lap. */
export function lapFigures(lap: LiveLap, profile: Pick<ResolvedProfile, "primary" | "pacePerMeters">): LapFigures {
  const meters = lap.distanceMm / 1000;
  const pace = paceOf(lap.movingMs, meters, profile.pacePerMeters);
  const rate: MetricText =
    profile.primary === "pace"
      ? { value: pace === null ? missingClock : formatClock(pace), unit: paceUnit(profile) }
      : { value: lap.movingMs <= 0 ? missing : formatSpeed(meters / (lap.movingMs / 1000)), unit: "km/h" };
  return { title: `Tour ${lap.index + 1}`, duration: formatLongClock(lap.elapsedMs / 1000), distance: formatDistance(meters), rate };
}

export interface SummaryFigures {
  /** Null for a stopwatch recording without a typed distance (`REC-060`), which then has no pace or speed either. */
  readonly distance: MetricText | null;
  readonly moving: string;
  /** Elapsed time, average pace or speed, then the sport's other values that were measured. */
  readonly stats: readonly StatValue[];
}

/** `REC-050`: the figures of the stop summary. */
export function summaryFigures(summary: Pick<RecordingSummary, "elapsedMs" | "movingMs" | "distanceMm" | "ascentMm" | "heartRateAvg" | "cadenceAvg" | "powerAvg">, profile: Pick<ResolvedProfile, "primary" | "pacePerMeters" | "cadence" | "stopwatch">): SummaryFigures {
  const meters = summary.distanceMm / 1000;
  const distanced = !profile.stopwatch || summary.distanceMm > 0;
  const pace = paceOf(summary.movingMs, meters, profile.pacePerMeters);
  const rate: StatValue =
    profile.primary === "pace"
      ? { label: "Allure moy.", value: pace === null ? missingClock : formatClock(pace), unit: paceUnit(profile) }
      : { label: "Vitesse moy.", value: summary.movingMs <= 0 ? missing : formatSpeed(meters / (summary.movingMs / 1000)), unit: "km/h" };
  const measured: StatValue[] = [
    ...(summary.ascentMm === null ? [] : [{ label: "D+", value: formatInteger(summary.ascentMm / 1000), unit: "m" }]),
    ...(summary.heartRateAvg === null ? [] : [{ label: "FC moy.", value: formatInteger(summary.heartRateAvg), unit: "bpm" }]),
    ...(summary.cadenceAvg === null ? [] : [{ label: "Cadence", value: formatInteger(summary.cadenceAvg), unit: cadenceUnit(profile) }]),
    ...(summary.powerAvg === null ? [] : [{ label: "Puiss. moy.", value: formatInteger(summary.powerAvg), unit: "W" }]),
  ];
  return {
    distance: distanced ? formatDistance(meters) : null,
    moving: formatLongClock(summary.movingMs / 1000),
    stats: [{ label: "Temps total", value: formatLongClock(summary.elapsedMs / 1000), unit: "" }, ...(distanced ? [rate] : []), ...measured],
  };
}
