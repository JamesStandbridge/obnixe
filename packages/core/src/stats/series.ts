import type { LocalDate } from "@obnixe/schema";
import { addDays, daysBetween, mondayOf } from "./dates.ts";

export type Better = "higher" | "lower" | null;

export interface Measured {
  readonly date: LocalDate;
  readonly value: number;
  readonly unreliable: boolean;
}

export function recordFlags(points: readonly Measured[], better: Better): boolean[] {
  if (better === null) return points.map(() => false);
  let best: number | null = null;
  return points.map((point) => {
    if (point.unreliable) return false;
    const improves = best !== null && (better === "higher" ? point.value > best : point.value < best);
    if (best === null || (better === "higher" ? point.value > best : point.value < best)) best = point.value;
    return improves;
  });
}

export function trend(points: readonly Measured[]): number | null {
  const usable = points.filter((point) => !point.unreliable);
  if (usable.length < 3) return null;
  const origin = usable[0]?.date;
  if (origin === undefined) return null;
  const xs = usable.map((point) => daysBetween(origin, point.date));
  const span = (xs[xs.length - 1] ?? 0) - (xs[0] ?? 0);
  if (span === 0) return null;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = usable.reduce((sum, point) => sum + point.value, 0) / usable.length;
  let numerator = 0;
  let denominator = 0;
  usable.forEach((point, index) => {
    const dx = (xs[index] ?? 0) - meanX;
    numerator += dx * (point.value - meanY);
    denominator += dx * dx;
  });
  return (numerator / denominator) * span;
}

export interface WeekTotal {
  readonly monday: LocalDate;
  readonly value: number;
  readonly count: number;
}

export interface DatedValue {
  readonly date: LocalDate;
  readonly value: number;
}

export function weeklyTotals(from: LocalDate, to: LocalDate, values: readonly DatedValue[]): WeekTotal[] {
  const weeks: WeekTotal[] = [];
  for (let monday = mondayOf(from); monday <= to; monday = addDays(monday, 7)) {
    const sunday = addDays(monday, 6);
    const inWeek = values.filter((item) => item.date >= monday && item.date <= sunday);
    weeks.push({ monday, value: inWeek.reduce((sum, item) => sum + item.value, 0), count: inWeek.length });
  }
  return weeks;
}

export function movingAverage(values: readonly DatedValue[], days: number): DatedValue[] {
  return values.map((item) => {
    const window = values.filter((other) => other.date <= item.date && daysBetween(other.date, item.date) < days);
    return { date: item.date, value: window.reduce((sum, other) => sum + other.value, 0) / window.length };
  });
}
