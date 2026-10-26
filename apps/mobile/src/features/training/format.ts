import { dateParts, gramsToMass, localTimeOf, weekdayIndex } from "@obnixe/core";
import type { Effort, EpochMs, Equipment, LocalDate, MassUnit, PainLevel, Sensation } from "@obnixe/schema";
import { monthLong, weekdayLong } from "@/format/dates";
import { formatNumber } from "@/format/numbers";

export function formatMass(grams: number, unit: MassUnit): string {
  return formatNumber(gramsToMass(grams, unit));
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${String(rest).padStart(2, "0")}`;
}

export function formatDay(date: LocalDate): string {
  return `${weekdayLong[weekdayIndex(date)]} ${dateParts(date).day}`;
}

export function formatLongDate(date: LocalDate): string {
  const { month, day } = dateParts(date);
  return `${weekdayLong[weekdayIndex(date)]} ${day} ${monthLong[month - 1] ?? ""}`;
}

/** "8:05", hours unpadded, on the wall clock of `timeZone`. */
export function formatTime(at: EpochMs, timeZone: string): string {
  const { minutes } = localTimeOf(at, timeZone);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

export const equipmentLabels: Readonly<Record<Equipment, string>> = {
  barbell: "barre",
  dumbbell: "haltères",
  kettlebell: "kettlebell",
  machine: "machine",
  cable: "poulie",
  bodyweight: "poids du corps",
  band: "élastique",
  other: "autre",
};

export const effortLabels: Readonly<Record<Effort, string>> = { easy: "Facile", moderate: "Modéré", hard: "Dur", very_hard: "Très dur", max: "Max" };

export const sensationLabels: Readonly<Record<Sensation, string>> = { heavy: "Lourd", normal: "Normal", light: "Léger" };

export const sensationPhrases: Readonly<Record<Sensation, string>> = { heavy: "sensation lourde", normal: "sensation normale", light: "sensation légère" };

export const painPhrases: Readonly<Record<PainLevel, string>> = { none: "calme", discomfort: "gêne", stop: "arrêt" };
