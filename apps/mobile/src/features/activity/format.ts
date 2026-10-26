import { addDays, daysBetween, localDateOf, weekdayOf } from "@obnixe/core";
import type { LastPain } from "@obnixe/core";
import type { LocalDate } from "@obnixe/schema";

const weekdays = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"] as const;
const weekdaysShort = ["Dim.", "Lun.", "Mar.", "Mer.", "Jeu.", "Ven.", "Sam."] as const;
const weekdayInitials = ["D", "L", "M", "M", "J", "V", "S"] as const;
const months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"] as const;
const monthsShort = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."] as const;

export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function todayLocal(now: number = Date.now()): LocalDate {
  return localDateOf(now, deviceTimeZone());
}

export function formatNumber(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  const trimmed = decimals > 0 ? fixed.replace(/\.?0+$/, "") : fixed;
  return trimmed.replace(".", ",").replace(/^-/, "−");
}

export function formatSigned(value: number, decimals: number): string {
  const rounded = Number(value.toFixed(decimals));
  if (rounded === 0) return formatNumber(0, decimals);
  return rounded > 0 ? `+${formatNumber(rounded, decimals)}` : formatNumber(rounded, decimals);
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function formatHoursMinutes(seconds: number): string {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${String(minutes).padStart(2, "0")}`;
}

export function formatTimeOfDay(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function parts(date: LocalDate): { readonly month: number; readonly day: number } {
  const [, month = 1, day = 1] = date.split("-").map(Number);
  return { month, day };
}

export function weekdayName(date: LocalDate): string {
  return weekdays[weekdayOf(date)] ?? "";
}

export function weekdayInitial(date: LocalDate): string {
  return weekdayInitials[weekdayOf(date)] ?? "";
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatDayMonth(date: LocalDate): string {
  const { month, day } = parts(date);
  return `${day} ${months[month - 1] ?? ""}`;
}

export function formatShortDay(date: LocalDate): string {
  const { month, day } = parts(date);
  return `${weekdaysShort[weekdayOf(date)] ?? ""} ${day} ${monthsShort[month - 1] ?? ""}`;
}

export function formatCompactDay(date: LocalDate): string {
  return `${weekdaysShort[weekdayOf(date)] ?? ""} ${parts(date).day}`;
}

export function formatRelativeDay(date: LocalDate, today: LocalDate): string {
  const gap = daysBetween(date, today);
  if (gap === 0) return "Aujourd'hui";
  if (gap === 1) return "Hier";
  if (gap > 1 && gap < 7) return capitalize(weekdayName(date));
  return formatShortDay(date);
}

export function formatAgo(date: LocalDate, today: LocalDate): string {
  const gap = daysBetween(date, today);
  if (gap <= 0) return "aujourd'hui";
  if (gap === 1) return "hier";
  return `il y a ${gap} j`;
}

export function painWord(level: LastPain["level"]): string {
  switch (level) {
    case "discomfort":
      return "gêne";
    case "stop":
      return "arrêt";
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
}

export function lastPainLabel(last: LastPain, today: LocalDate): string {
  return `${painWord(last.level)} ${formatAgo(last.localDate, today)}`;
}

export function shiftDay(date: LocalDate, days: number): LocalDate {
  return addDays(date, days);
}

export function durationFromDigits(digits: string): number {
  const padded = digits.padStart(6, "0");
  const hours = Number(padded.slice(0, -4));
  const minutes = Number(padded.slice(-4, -2));
  const seconds = Number(padded.slice(-2));
  return hours * 3600 + minutes * 60 + seconds;
}

export function formatDigitsAsClock(digits: string): string {
  const padded = digits.padStart(4, "0");
  const hours = padded.slice(0, -4);
  const minutes = padded.slice(-4, -2);
  const seconds = padded.slice(-2);
  return hours === "" ? `${Number(minutes)}:${seconds}` : `${Number(hours)}:${minutes}:${seconds}`;
}
