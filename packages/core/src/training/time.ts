import type { EpochMs, LocalDate, Session } from "@obnixe/schema";

export const resumeUntilHour = 6;

interface LocalParts {
  readonly date: LocalDate;
  readonly hour: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  formatters.set(timeZone, created);
  return created;
}

export function localParts(at: EpochMs, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(at));
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${value("year")}-${value("month")}-${value("day")}` as LocalDate, hour: Number(value("hour")) % 24 };
}

export function localDateOf(at: EpochMs, timeZone: string): LocalDate {
  return localParts(at, timeZone).date;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return shifted.toISOString().slice(0, 10) as LocalDate;
}

export function isResumable(session: Pick<Session, "status" | "localDate" | "timeZone">, now: EpochMs): boolean {
  if (session.status === "completed") return false;
  const current = localParts(now, session.timeZone);
  if (current.date <= session.localDate) return true;
  return current.date === addDays(session.localDate, 1) && current.hour < resumeUntilHour;
}

export function activeSeconds(session: Pick<Session, "startedAt" | "endedAt" | "pausedSeconds">, now: EpochMs): number {
  const end = session.endedAt ?? now;
  return Math.max(0, Math.round((end - session.startedAt) / 1000) - session.pausedSeconds);
}
