import { dateParts, daysBetween, localClock, weekdayIndex, addDays } from "@obnixe/core";
import { zones } from "@obnixe/schema";
import type { Effort, EpochMs, LocalDate, PainLevel, SleepBucket, ZoneKey } from "@obnixe/schema";
import { deviceTimeZone } from "@/features/stats/live";

export const weekdayLong = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"] as const;
export const weekdayShort = ["Lun.", "Mar.", "Mer.", "Jeu.", "Ven.", "Sam.", "Dim."] as const;
export const weekdayLetters = ["L", "M", "M", "J", "V", "S", "D"] as const;
export const weekdayAbbrev = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."] as const;
export const monthLong = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"] as const;
export const monthShort = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."] as const;

const groupSeparator = "\u00a0";

export function capitalize(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function lowerFirst(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
}

export function formatNumber(value: number, maxDecimals = 1, minDecimals = 0): string {
  const factor = 10 ** maxDecimals;
  const rounded = Math.round(Math.abs(value) * factor) / factor;
  let [whole = "0", fraction = ""] = rounded.toFixed(maxDecimals).split(".");
  fraction = fraction.replace(/0+$/, "");
  while (fraction.length < minDecimals) fraction += "0";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator);
  const sign = value < 0 && rounded !== 0 ? "−" : "";
  return `${sign}${grouped}${fraction.length > 0 ? `,${fraction}` : ""}`;
}

export function formatInteger(value: number): string {
  const rounded = Math.round(value);
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator);
  return `${rounded < 0 ? "−" : ""}${digits}`;
}

export function formatSigned(value: number, format: (value: number) => string): string {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${format(Math.abs(value))}`;
}

export function formatKilometers(meters: number): string {
  return formatNumber(meters / 1000, 1, 1);
}

export function formatKilograms(grams: number): string {
  return formatNumber(grams / 1000, 1);
}

export function formatMinutesSeconds(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
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

export function formatClockMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function formatTimeOf(at: EpochMs): string {
  return formatClockMinutes(localClock(at, deviceTimeZone).minutes);
}

export function localDateOf(at: EpochMs): LocalDate {
  return localClock(at, deviceTimeZone).date;
}

export function longDate(date: LocalDate): string {
  const { month, day } = dateParts(date);
  return `${weekdayLong[weekdayIndex(date)]} ${day} ${monthLong[month - 1]}`;
}

export function dayMonth(date: LocalDate): string {
  const { month, day } = dateParts(date);
  return `${day} ${monthLong[month - 1]}`;
}

export function shortDate(date: LocalDate): string {
  const { month, day } = dateParts(date);
  return `${day} ${monthShort[month - 1]}`;
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

export function relativeDay(date: LocalDate, today: LocalDate): string {
  const days = daysBetween(date, today);
  if (days === 0) return "aujourd'hui";
  if (days === 1) return "hier";
  if (days === 2) return "avant-hier";
  if (days > 0 && days < 7) return weekdayLong[weekdayIndex(date)] ?? shortDate(date);
  return `le ${shortDate(date)}`;
}

export function weekRange(monday: LocalDate): string {
  const sunday = addDays(monday, 6);
  const start = dateParts(monday);
  const end = dateParts(sunday);
  if (start.month === end.month) return `${start.day} – ${end.day} ${monthLong[end.month - 1]}`;
  return `${start.day} ${monthShort[start.month - 1]} – ${end.day} ${monthShort[end.month - 1]}`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatInteger(count)} ${count > 1 ? pluralForm : singular}`;
}

export function sessionsCount(count: number): string {
  return plural(count, "séance");
}

export function zoneLabel(zone: ZoneKey): string {
  return zones[zone].label;
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
