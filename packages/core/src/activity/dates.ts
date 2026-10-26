import type { EpochMs, LocalDate } from "@obnixe/schema";


interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hours: number;
  readonly minutes: number;
}

export interface LocalTime {
  readonly date: LocalDate;
  readonly minutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
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
  formatters.set(timeZone, created);
  return created;
}

function wallClock(at: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(at));
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  return { year: read("year"), month: read("month"), day: read("day"), hours: read("hour") % 24, minutes: read("minute") };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dateOf(clock: Pick<WallClock, "year" | "month" | "day">): LocalDate {
  return `${clock.year}-${pad(clock.month)}-${pad(clock.day)}` as LocalDate;
}

function utcMidnight(date: LocalDate): number {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export function localDateOf(at: number, timeZone: string): LocalDate {
  return dateOf(wallClock(at, timeZone));
}

export function localTimeOf(at: number, timeZone: string): LocalTime {
  const clock = wallClock(at, timeZone);
  return { date: dateOf(clock), minutes: clock.hours * 60 + clock.minutes };
}

export function weekdayOf(date: LocalDate): number {
  return new Date(utcMidnight(date)).getUTCDay();
}

function offsetAt(at: number, timeZone: string): number {
  const clock = wallClock(at, timeZone);
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hours, clock.minutes);
  return asUtc - Math.floor(at / 60_000) * 60_000;
}

export function epochAt(time: LocalTime, timeZone: string): EpochMs {
  const guess = utcMidnight(time.date) + time.minutes * 60_000;
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  return second as EpochMs;
}
