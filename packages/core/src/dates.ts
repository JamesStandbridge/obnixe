import type { EpochMs, LocalDate } from "@obnixe/schema";

export const dayMs = 86_400_000;

/** 0 is Monday, 6 is Sunday. */
export type WeekdayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface MonthRef {
  readonly year: number;
  readonly month: number;
}

export interface LocalTime {
  readonly date: LocalDate;
  readonly minutes: number;
}

export class InvalidLocalDateError extends Error {
  readonly value: string;

  constructor(value: string) {
    super(`${value} is not a YYYY-MM-DD date`);
    this.value = value;
  }
}

export function dateParts(date: LocalDate): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) throw new InvalidLocalDateError(date);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

export function localDate(year: number, month: number, day: number): LocalDate {
  const utc = new Date(Date.UTC(year, month - 1, day));
  return `${pad(utc.getUTCFullYear(), 4)}-${pad(utc.getUTCMonth() + 1, 2)}-${pad(utc.getUTCDate(), 2)}` as LocalDate;
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

export function weekdayIndex(date: LocalDate): WeekdayIndex {
  return ((new Date(utcOf(date)).getUTCDay() + 6) % 7) as WeekdayIndex;
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

interface WallClock extends DateParts {
  readonly hours: number;
  readonly minutes: number;
}

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = wallClockFormatters.get(timeZone);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  wallClockFormatters.set(timeZone, created);
  return created;
}

function wallClock(at: EpochMs, timeZone: string): WallClock {
  const parts = wallClockFormatter(timeZone).formatToParts(new Date(at));
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  return { year: read("year"), month: read("month"), day: read("day"), hours: read("hour") % 24, minutes: read("minute") };
}

export function localTimeOf(at: EpochMs, timeZone: string): LocalTime {
  const clock = wallClock(at, timeZone);
  return { date: localDate(clock.year, clock.month, clock.day), minutes: clock.hours * 60 + clock.minutes };
}

export function localDateOf(at: EpochMs, timeZone: string): LocalDate {
  return localTimeOf(at, timeZone).date;
}

function offsetAt(at: EpochMs, timeZone: string): number {
  const clock = wallClock(at, timeZone);
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hours, clock.minutes);
  return asUtc - Math.floor(at / 60_000) * 60_000;
}

export function epochAt(time: LocalTime, timeZone: string): EpochMs {
  const guess = utcOf(time.date) + time.minutes * 60_000;
  const first = guess - offsetAt(guess as EpochMs, timeZone);
  return (guess - offsetAt(first as EpochMs, timeZone)) as EpochMs;
}
