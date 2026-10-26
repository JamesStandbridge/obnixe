import { gramsToMass } from "@obnixe/core";
import { zones } from "@obnixe/schema";
import type { Effort, EpochMs, Equipment, LocalDate, MassUnit, PainLevel, Sensation, ZoneKey } from "@obnixe/schema";

const weekdays = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"] as const;
const months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"] as const;
const dayMs = 86_400_000;

export function formatNumber(value: number, fractionDigits = 1): string {
  const factor = 10 ** fractionDigits;
  const rounded = Math.round(value * factor) / factor;
  const [integer = "0", fraction] = Math.abs(rounded).toString().split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  return `${rounded < 0 ? "−" : ""}${grouped}${fraction === undefined ? "" : `,${fraction}`}`;
}

export function formatSigned(value: number, fractionDigits = 1): string {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatNumber(Math.abs(value), fractionDigits)}`;
}

export function formatMass(grams: number, unit: MassUnit): string {
  return formatNumber(gramsToMass(grams, unit));
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function formatLongClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  if (hours === 0) return formatClock(whole);
  return `${hours}:${String(Math.floor((whole % 3600) / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${String(rest).padStart(2, "0")}`;
}

interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function partsOf(date: LocalDate): DateParts {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  return { year, month, day };
}

function weekdayOf(date: LocalDate): string {
  const { year, month, day } = partsOf(date);
  return weekdays[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "";
}

export function formatDay(date: LocalDate): string {
  return `${weekdayOf(date)} ${partsOf(date).day}`;
}

export function formatLongDate(date: LocalDate): string {
  const { month, day } = partsOf(date);
  return `${weekdayOf(date)} ${day} ${months[month - 1] ?? ""}`;
}

export function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

export function lowerFirst(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toLowerCase() ?? ""}${text.slice(1)}`;
}

export function daysBetween(from: LocalDate, to: LocalDate): number {
  const a = partsOf(from);
  const b = partsOf(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / dayMs);
}

export function relativeDay(date: LocalDate, today: LocalDate): string {
  const days = daysBetween(date, today);
  if (days >= 1 && days <= 6) return weekdayOf(date);
  const { month, day } = partsOf(date);
  return `le ${day} ${months[month - 1] ?? ""}`;
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatTime(at: EpochMs, timeZone: string): string {
  let formatter = clockFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    clockFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(at));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

export function zoneLabel(zone: ZoneKey): string {
  return zones[zone].label;
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

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}
