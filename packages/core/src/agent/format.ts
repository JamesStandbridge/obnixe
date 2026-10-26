import type { LocalDate } from "@obnixe/schema";
import { dateParts } from "../dates.ts";

const months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"] as const;

function dayLabel(day: number): string {
  return day === 1 ? "1er" : String(day);
}

function monthName(month: number): string {
  return months[month - 1] ?? "";
}

export function lowerFirst(text: string): string {
  return text.charAt(0).toLocaleLowerCase("fr-FR") + text.slice(1);
}

/** "10 octobre" */
export function frenchDay(localDate: LocalDate): string {
  const { day, month } = dateParts(localDate);
  return `${dayLabel(day)} ${monthName(month)}`;
}

/** "du 3 au 30 octobre", "du 28 septembre au 4 octobre" */
export function frenchSpan(from: LocalDate, to: LocalDate): string {
  const start = dateParts(from);
  const end = dateParts(to);
  if (from === to) return `du ${frenchDay(from)}`;
  if (start.month === end.month && start.year === end.year) return `du ${dayLabel(start.day)} au ${frenchDay(to)}`;
  return `du ${frenchDay(from)} au ${frenchDay(to)}`;
}

/** "9,2 km", "32 km", "800 m" */
export function frenchDistance(meters: number): string {
  if (meters < 1000) return `${meters} m`;
  const kilometers = meters / 1000;
  const rounded = kilometers >= 20 ? Math.round(kilometers) : Math.round(kilometers * 10) / 10;
  return `${rounded.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km`;
}

/** "45 min", "1 h 30" */
export function frenchDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")}`;
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}
