import { and, asc, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { checkIn, painReport, weighIn } from "@obnixe/schema";
import type { Id, LocalDate, PainLevel, SleepBucket, SportKey, ZoneKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { addDays, compareMonths, daysInMonth, localDate, mondayOf, monthOf, weekdayIndex } from "../dates.ts";
import type { MonthRef } from "../dates.ts";
import { groupBy, worsePain } from "./sessions.ts";
import type { ReportedPainLevel, SessionSummary } from "./sessions.ts";
import { plannedDays } from "./week.ts";

export interface CheckInZone {
  readonly zone: ZoneKey;
  readonly level: PainLevel;
}

export interface CheckInDay {
  readonly id: Id;
  readonly localDate: LocalDate;
  readonly energy: number | null;
  readonly sleep: SleepBucket | null;
  readonly zones: readonly CheckInZone[];
}

export interface WeighInDay {
  readonly localDate: LocalDate;
  readonly grams: number;
}

export interface DateRange {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

export function checkInDays(db: ObnixeDatabase, range: DateRange): CheckInDay[] {
  const rows = db
    .select()
    .from(checkIn)
    .where(and(isNull(checkIn.deletedAt), gte(checkIn.localDate, range.from), lte(checkIn.localDate, range.to)))
    .orderBy(asc(checkIn.localDate))
    .all();
  const reports = groupBy(
    db
      .select({ checkInId: painReport.checkInId, zone: painReport.zone, level: painReport.level })
      .from(painReport)
      .where(and(isNotNull(painReport.checkInId), isNull(painReport.deletedAt), gte(painReport.localDate, range.from), lte(painReport.localDate, range.to)))
      .all(),
    (row) => row.checkInId,
  );
  return rows.map((row) => ({
    id: row.id,
    localDate: row.localDate,
    energy: row.energy,
    sleep: row.sleep,
    zones: (reports.get(row.id) ?? []).map((report) => ({ zone: report.zone, level: report.level })),
  }));
}

export function weighInDays(db: ObnixeDatabase, range: DateRange): WeighInDay[] {
  return db
    .select({ localDate: weighIn.localDate, grams: weighIn.grams })
    .from(weighIn)
    .where(and(isNull(weighIn.deletedAt), gte(weighIn.localDate, range.from), lte(weighIn.localDate, range.to)))
    .orderBy(asc(weighIn.localDate))
    .all();
}

export interface CalendarDay {
  readonly date: LocalDate;
  readonly inMonth: boolean;
  readonly isToday: boolean;
  readonly isFuture: boolean;
  readonly planned: boolean;
  readonly sessions: readonly SessionSummary[];
  readonly checkIn: CheckInDay | null;
}

export interface CalendarMonth {
  readonly month: MonthRef;
  readonly isCurrent: boolean;
  readonly cells: readonly CalendarDay[];
}

export interface CalendarInput {
  readonly month: MonthRef;
  readonly today: LocalDate;
  readonly sessions: readonly SessionSummary[];
  readonly checkIns: readonly CheckInDay[];
  readonly sessionsPerWeek: number | null;
}

export function calendarMonth(input: CalendarInput): CalendarMonth {
  const first = localDate(input.month.year, input.month.month, 1);
  const offset = weekdayIndex(first);
  const length = daysInMonth(input.month);
  const byDay = groupBy(input.sessions, (item) => item.localDate);
  const checkIns = new Map(input.checkIns.map((item) => [item.localDate, item]));
  const planned = new Set<LocalDate>();
  for (let monday = mondayOf(first); monday <= addDays(first, length - 1); monday = addDays(monday, 7)) {
    if (addDays(monday, 6) < input.today) continue;
    const dates = input.sessions.filter((item) => item.localDate >= monday && item.localDate <= addDays(monday, 6)).map((item) => item.localDate);
    for (const date of plannedDays(monday, input.today, dates, input.sessionsPerWeek)) planned.add(date);
  }
  const cells: CalendarDay[] = [];
  for (let index = -offset; index < length; index += 1) {
    const date = addDays(first, index);
    const inMonth = index >= 0;
    cells.push({
      date,
      inMonth,
      isToday: date === input.today,
      isFuture: date > input.today,
      planned: inMonth && planned.has(date) && date > input.today,
      sessions: inMonth ? (byDay.get(date) ?? []) : [],
      checkIn: inMonth ? (checkIns.get(date) ?? null) : null,
    });
  }
  return { month: input.month, isCurrent: compareMonths(input.month, monthOf(input.today)) === 0, cells };
}

export function visibleSessions(day: Pick<CalendarDay, "sessions">, filter: SportKey | null): readonly SessionSummary[] {
  return filter === null ? day.sessions : day.sessions.filter((item) => item.sport === filter);
}

export function dayPain(day: Pick<CalendarDay, "sessions" | "checkIn">, filter: SportKey | null): ReportedPainLevel | null {
  let worst: ReportedPainLevel | null = null;
  for (const item of visibleSessions(day, filter)) for (const pain of item.pains) worst = worsePain(worst, pain.level);
  for (const zone of day.checkIn?.zones ?? []) if (zone.level !== "none") worst = worsePain(worst, zone.level);
  return worst;
}

export interface MonthFacts {
  readonly sessions: number;
  readonly durationSeconds: number;
  readonly painDays: number;
}

export function monthFacts(month: CalendarMonth, filter: SportKey | null): MonthFacts {
  const days = month.cells.filter((cell) => cell.inMonth);
  const sessions = days.flatMap((day) => visibleSessions(day, filter));
  return {
    sessions: sessions.length,
    durationSeconds: sessions.reduce((sum, item) => sum + (item.durationSeconds ?? 0), 0),
    painDays: days.filter((day) => dayPain(day, filter) !== null).length,
  };
}
