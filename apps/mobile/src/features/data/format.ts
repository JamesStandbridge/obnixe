import type { EpochMs, LocalDate } from "@obnixe/schema";
import type { WeekdayIndex } from "@obnixe/core";

const weekdayNames = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"] as const;
const monthNames = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"] as const;
const shortMonthNames = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."] as const;
const shortWeekdays: Readonly<Record<WeekdayIndex, string>> = { 0: "lun", 1: "mar", 2: "mer", 3: "jeu", 4: "ven", 5: "sam", 6: "dim" };
export const weekdayInitials: Readonly<Record<WeekdayIndex, string>> = { 0: "L", 1: "M", 2: "M", 3: "J", 4: "V", 5: "S", 6: "D" };
export const weekdayLabels: Readonly<Record<WeekdayIndex, string>> = { 0: "lundi", 1: "mardi", 2: "mercredi", 3: "jeudi", 4: "vendredi", 5: "samedi", 6: "dimanche" };

const dayMs = 86_400_000;
const pad = (value: number): string => String(value).padStart(2, "0");

export function clock(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function longDateTime(instant: EpochMs): string {
  const date = new Date(instant);
  return `${weekdayNames[date.getDay()]} ${date.getDate()} ${monthNames[date.getMonth()]}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dayMonth(instant: EpochMs): string {
  const date = new Date(instant);
  return `${date.getDate() === 1 ? "1er" : date.getDate()} ${monthNames[date.getMonth()]}`;
}

export function shortDate(instant: EpochMs): string {
  const date = new Date(instant);
  return `${date.getDate()} ${shortMonthNames[date.getMonth()]}`;
}

export function shortLocalDate(day: LocalDate): string {
  const [, month, date] = day.split("-").map(Number);
  return `${date ?? 1} ${shortMonthNames[(month ?? 1) - 1]}`;
}

export function localDateOf(instant: EpochMs): LocalDate {
  const date = new Date(instant);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` as LocalDate;
}

export function fileStamp(instant: EpochMs): string {
  return localDateOf(instant);
}

function startOfDay(instant: number): number {
  const date = new Date(instant);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function daysBetween(from: EpochMs, to: EpochMs): number {
  return Math.round((startOfDay(to) - startOfDay(from)) / dayMs);
}

export function weekdayList(days: readonly WeekdayIndex[]): string {
  return days.map((day) => shortWeekdays[day]).join(", ");
}

export function megabytes(bytes: number): string {
  const value = bytes / 1_000_000;
  if (value < 0.1) return "0,1";
  return value < 10 ? value.toFixed(1).replace(".", ",") : String(Math.round(value));
}

export function fileSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${megabytes(bytes)} Mo`;
  return `${Math.max(1, Math.round(bytes / 1000))} Ko`;
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}
