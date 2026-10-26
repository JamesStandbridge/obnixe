import type { LocalDate } from "@obnixe/schema";
import { addDays, mondayOf, weekDates } from "../dates.ts";
import type { SessionSummary } from "./sessions.ts";

export type WeekDayState = "done" | "planned" | "rest";

export interface WeekDay {
  readonly date: LocalDate;
  readonly state: WeekDayState;
  readonly isToday: boolean;
  readonly sessions: number;
}

export interface WeekSummary {
  readonly monday: LocalDate;
  readonly days: readonly WeekDay[];
  readonly sessionsDone: number;
  readonly sessionsPlanned: number | null;
  readonly durationSeconds: number;
}

type DatedSession = Pick<SessionSummary, "localDate" | "durationSeconds">;

function spread(candidates: readonly LocalDate[], count: number): Set<LocalDate> {
  const picked = new Set<LocalDate>();
  const wanted = Math.min(count, candidates.length);
  for (let index = 0; index < wanted; index += 1) {
    const candidate = candidates[Math.floor((index * candidates.length) / wanted)];
    if (candidate !== undefined) picked.add(candidate);
  }
  return picked;
}

export function plannedDays(monday: LocalDate, today: LocalDate, sessionDates: readonly LocalDate[], sessionsPerWeek: number | null): Set<LocalDate> {
  if (sessionsPerWeek === null) return new Set();
  const days = weekDates(monday);
  const done = new Set(sessionDates);
  const doneCount = sessionDates.filter((date) => days.includes(date)).length;
  const remaining = Math.max(0, sessionsPerWeek - doneCount);
  const candidates = days.filter((date) => date >= today && !done.has(date));
  return spread(candidates, remaining);
}

export function weekSummary(today: LocalDate, sessions: readonly DatedSession[], sessionsPerWeek: number | null): WeekSummary {
  const monday = mondayOf(today);
  const days = weekDates(monday);
  const inWeek = sessions.filter((item) => days.includes(item.localDate));
  const planned = plannedDays(monday, today, inWeek.map((item) => item.localDate), sessionsPerWeek);
  return {
    monday,
    days: days.map((date) => {
      const count = inWeek.filter((item) => item.localDate === date).length;
      return { date, state: count > 0 ? "done" : planned.has(date) ? "planned" : "rest", isToday: date === today, sessions: count };
    }),
    sessionsDone: inWeek.length,
    sessionsPlanned: sessionsPerWeek,
    durationSeconds: inWeek.reduce((sum, item) => sum + (item.durationSeconds ?? 0), 0),
  };
}

export interface RegularityWeek {
  readonly monday: LocalDate;
  readonly done: number;
  readonly planned: number;
  readonly isCurrent: boolean;
}

export interface Regularity {
  readonly weeks: readonly RegularityWeek[];
  readonly averagePerWeek: number;
}

export function regularity(today: LocalDate, sessions: readonly Pick<SessionSummary, "localDate">[], weeks: number, sessionsPerWeek: number | null): Regularity {
  const current = mondayOf(today);
  const result: RegularityWeek[] = [];
  for (let offset = weeks - 1; offset >= 0; offset -= 1) {
    const monday = addDays(current, -7 * offset);
    const days = weekDates(monday);
    const dates = sessions.filter((item) => days.includes(item.localDate)).map((item) => item.localDate);
    const isCurrent = offset === 0;
    const planned = isCurrent ? plannedDays(monday, today, dates, sessionsPerWeek).size : 0;
    result.push({ monday, done: dates.length, planned, isCurrent });
  }
  const total = result.reduce((sum, week) => sum + week.done, 0);
  return { weeks: result, averagePerWeek: weeks === 0 ? 0 : total / weeks };
}
