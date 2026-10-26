import { dateParts, daysBetween, localDateOf, localTimeOf, weekdayIndex } from "@obnixe/core";
import type { EpochMs, LocalDate } from "@obnixe/schema";
import { capitalize } from "@/format/labels";

export const weekdayLong = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"] as const;
export const monthLong = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"] as const;
export const monthShort = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."] as const;

/** IANA zone of the device; falls back to UTC when the runtime reports something unusable. */
export function deviceTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return /^(UTC|[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2})$/.test(zone) ? zone : "UTC";
}

export function formatTimeOfDay(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function formatTimeAt(at: EpochMs, timeZone: string): string {
  return formatTimeOfDay(localTimeOf(at, timeZone).minutes);
}

export function weekdayTitle(at: EpochMs, timeZone: string): string {
  const date = localDateOf(at, timeZone);
  const { day, month } = dateParts(date);
  return capitalize(`${weekdayLong[weekdayIndex(date)]} ${day === 1 ? "1er" : day} ${monthLong[month - 1]}`);
}

export function shortDate(date: LocalDate): string {
  const { month, day } = dateParts(date);
  return `${day} ${monthShort[month - 1]}`;
}

/** "aujourd'hui", "hier", "avant-hier", the weekday within a week, then "le 3 oct.". */
export function relativeDay(date: LocalDate, today: LocalDate): string {
  const days = daysBetween(date, today);
  if (days === 0) return "aujourd'hui";
  if (days === 1) return "hier";
  if (days === 2) return "avant-hier";
  if (days > 0 && days < 7) return weekdayLong[weekdayIndex(date)];
  return `le ${shortDate(date)}`;
}
