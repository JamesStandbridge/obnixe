import { addDays, dateParts, daysBetween, weekdayIndex } from "@obnixe/core";
import type { LastPain } from "@obnixe/core";
import type { LocalDate } from "@obnixe/schema";
import { monthLong, monthShort, weekdayLong } from "@/format/dates";
import { capitalize } from "@/format/labels";

const weekdaysShort = ["Lun.", "Mar.", "Mer.", "Jeu.", "Ven.", "Sam.", "Dim."] as const;
const weekdayInitials = ["L", "M", "M", "J", "V", "S", "D"] as const;

export function formatHoursMinutes(seconds: number): string {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${String(minutes).padStart(2, "0")}`;
}

export function weekdayName(date: LocalDate): string {
  return weekdayLong[weekdayIndex(date)];
}

export function weekdayInitial(date: LocalDate): string {
  return weekdayInitials[weekdayIndex(date)];
}

export function formatDayMonth(date: LocalDate): string {
  const { month, day } = dateParts(date);
  return `${day} ${monthLong[month - 1] ?? ""}`;
}

export function formatShortDay(date: LocalDate): string {
  const { month, day } = dateParts(date);
  return `${weekdaysShort[weekdayIndex(date)]} ${day} ${monthShort[month - 1] ?? ""}`;
}

export function formatCompactDay(date: LocalDate): string {
  return `${weekdaysShort[weekdayIndex(date)]} ${dateParts(date).day}`;
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
