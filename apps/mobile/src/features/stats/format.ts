import { addDays, dateParts, weekdayIndex } from "@obnixe/core";
import type { Effort, LocalDate, PainLevel, SleepBucket } from "@obnixe/schema";
import { monthLong, monthShort, weekdayLong } from "@/format/dates";
import { capitalize, plural } from "@/format/labels";
import { formatNumber } from "@/format/numbers";

export const weekdayShort = ["Lun.", "Mar.", "Mer.", "Jeu.", "Ven.", "Sam.", "Dim."] as const;
export const weekdayLetters = ["L", "M", "M", "J", "V", "S", "D"] as const;
export const weekdayAbbrev = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."] as const;

export function formatKilometers(meters: number): string {
  return formatNumber(meters / 1000, 1, 1);
}

export function formatKilograms(grams: number): string {
  return formatNumber(grams / 1000, 1);
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

export interface FigureText {
  readonly value: string;
  readonly unit: string;
}

export function durationFigure(seconds: number): FigureText {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { value: String(minutes), unit: "min" };
  return { value: formatDuration(seconds), unit: "" };
}

export function longDate(date: LocalDate): string {
  const { month, day } = dateParts(date);
  return `${weekdayLong[weekdayIndex(date)]} ${day} ${monthLong[month - 1]}`;
}

export function dayMonth(date: LocalDate): string {
  const { month, day } = dateParts(date);
  return `${day} ${monthLong[month - 1]}`;
}

export function rowDay(date: LocalDate): string {
  return `${weekdayShort[weekdayIndex(date)]} ${dateParts(date).day}`;
}

export function rowDate(date: LocalDate): string {
  return `${rowDay(date)} ${monthShort[dateParts(date).month - 1]}`;
}

export function monthTitle(year: number, month: number): string {
  return `${capitalize(monthLong[month - 1] ?? "")} ${year}`;
}

export function weekRange(monday: LocalDate): string {
  const sunday = addDays(monday, 6);
  const start = dateParts(monday);
  const end = dateParts(sunday);
  if (start.month === end.month) return `${start.day} – ${end.day} ${monthLong[end.month - 1]}`;
  return `${start.day} ${monthShort[start.month - 1]} – ${end.day} ${monthShort[end.month - 1]}`;
}

export function sessionsCount(count: number): string {
  return plural(count, "séance");
}

export const painWords: Readonly<Record<Exclude<PainLevel, "none">, string>> = { discomfort: "gêne", stop: "arrêt" };

export const levelWords: Readonly<Record<PainLevel, string>> = { none: "calme", discomfort: "gêne", stop: "arrêt" };

export function effortLabel(effort: Effort): string {
  switch (effort) {
    case "easy":
      return "facile";
    case "moderate":
      return "modéré";
    case "hard":
      return "dur";
    case "very_hard":
      return "très dur";
    case "max":
      return "max";
    default: {
      const unreachable: never = effort;
      return unreachable;
    }
  }
}

export function sleepHours(bucket: SleepBucket): number {
  switch (bucket) {
    case "lt6":
      return 5.5;
    case "h6":
      return 6;
    case "h7":
      return 7;
    case "h8":
      return 8;
    case "gte9":
      return 9;
    default: {
      const unreachable: never = bucket;
      return unreachable;
    }
  }
}

export function sleepLabel(bucket: SleepBucket): string {
  switch (bucket) {
    case "lt6":
      return "< 6 h";
    case "h6":
      return "6 h";
    case "h7":
      return "7 h";
    case "h8":
      return "8 h";
    case "gte9":
      return "9 h +";
    default: {
      const unreachable: never = bucket;
      return unreachable;
    }
  }
}
