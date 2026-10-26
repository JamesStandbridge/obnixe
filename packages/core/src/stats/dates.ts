import type { EpochMs, LocalDate } from "@obnixe/schema";

export const dayMs = 86_400_000;

export interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface MonthRef {
  readonly year: number;
  readonly month: number;
}

export class InvalidLocalDateError extends Error {
  constructor(readonly value: string) {
    super(`${value} is not a YYYY-MM-DD date`);
  }
}

export function dateParts(date: LocalDate): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) throw new InvalidLocalDateError(date);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function localDate(year: number, month: number, day: number): LocalDate {
  const utc = new Date(Date.UTC(year, month - 1, day));
  return `${String(utc.getUTCFullYear()).padStart(4, "0")}-${String(utc.getUTCMonth() + 1).padStart(2, "0")}-${String(utc.getUTCDate()).padStart(2, "0")}` as LocalDate;
}

function utcOf(date: LocalDate): number {
  const { year, month, day } = dateParts(date);
  return Date.UTC(year, month - 1, day);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const { year, month, day } = dateParts(date);
  return localDate(year, month, day + days);
}

export function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((utcOf(to) - utcOf(from)) / dayMs);
}

export function weekdayIndex(date: LocalDate): number {
  return (new Date(utcOf(date)).getUTCDay() + 6) % 7;
}

export function mondayOf(date: LocalDate): LocalDate {
  return addDays(date, -weekdayIndex(date));
}

export function weekDates(monday: LocalDate): readonly LocalDate[] {
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

export function monthOf(date: LocalDate): MonthRef {
  const { year, month } = dateParts(date);
  return { year, month };
}

export function addMonths(ref: MonthRef, months: number): MonthRef {
  const index = ref.year * 12 + (ref.month - 1) + months;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function compareMonths(left: MonthRef, right: MonthRef): number {
  return left.year * 12 + left.month - (right.year * 12 + right.month);
}

export function daysInMonth(ref: MonthRef): number {
  return new Date(Date.UTC(ref.year, ref.month, 0)).getUTCDate();
}

export function monthStart(ref: MonthRef): LocalDate {
  return localDate(ref.year, ref.month, 1);
}

export function monthEnd(ref: MonthRef): LocalDate {
  return localDate(ref.year, ref.month, daysInMonth(ref));
}

export interface LocalClock {
  readonly date: LocalDate;
  readonly minutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const known = formatters.get(timeZone);
  if (known !== undefined) return known;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  formatters.set(timeZone, created);
  return created;
}

export function localClock(at: EpochMs, timeZone: string): LocalClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(at));
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  return { date: localDate(value("year"), value("month"), value("day")), minutes: (value("hour") % 24) * 60 + value("minute") };
}

export function localDateAt(at: EpochMs, timeZone: string): LocalDate {
  return localClock(at, timeZone).date;
}
