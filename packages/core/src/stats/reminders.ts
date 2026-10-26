import type { EpochMs, LocalDate } from "@obnixe/schema";
import { addDays, dateParts, weekdayIndex } from "../dates.ts";

export const reminderMinutesRange = { min: 5 * 60, max: 22 * 60, step: 30 } as const;

const icsDays = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

export function reminderDays(mask: number): number[] {
  return icsDays.map((_, index) => index).filter((index) => (mask & (1 << index)) !== 0);
}

export function reminderMask(days: readonly number[]): number {
  return days.reduce((mask, day) => {
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new RangeError(`Weekday ${day} is outside 0..6`);
    return mask | (1 << day);
  }, 0);
}

export function toggleReminderDay(mask: number, day: number): number {
  return mask ^ reminderMask([day]);
}

export function clampReminderMinutes(minutes: number): number {
  return Math.min(reminderMinutesRange.max, Math.max(reminderMinutesRange.min, minutes));
}

export interface ReminderCalendar {
  readonly mask: number;
  readonly minutes: number;
  readonly from: LocalDate;
  readonly stamp: EpochMs;
  readonly summary: string;
  readonly description: string;
  readonly durationMinutes: number;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function floatingTime(date: LocalDate, minutes: number): string {
  const { year, month, day } = dateParts(date);
  return `${pad(year, 4)}${pad(month)}${pad(day)}T${pad(Math.floor(minutes / 60))}${pad(minutes % 60)}00`;
}

function utcStamp(at: EpochMs): string {
  const date = new Date(at);
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function fold(line: string): string {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    parts.push(rest.slice(0, 74));
    rest = ` ${rest.slice(74)}`;
  }
  parts.push(rest);
  return parts.join("\r\n");
}

export function remindersIcs(calendar: ReminderCalendar): string {
  const days = reminderDays(calendar.mask);
  if (days.length === 0) throw new RangeError("At least one reminder day is required");
  const end = calendar.minutes + calendar.durationMinutes;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Obnixe//Rappels//FR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const day of days) {
    const first = addDays(calendar.from, (day - weekdayIndex(calendar.from) + 7) % 7);
    lines.push(
      "BEGIN:VEVENT",
      `UID:obnixe-rappel-${icsDays[day]?.toLowerCase() ?? day}@obnixe.app`,
      `DTSTAMP:${utcStamp(calendar.stamp)}`,
      `DTSTART:${floatingTime(first, calendar.minutes)}`,
      `DTEND:${floatingTime(first, Math.min(end, 23 * 60 + 59))}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${icsDays[day] ?? "MO"}`,
      `SUMMARY:${escapeText(calendar.summary)}`,
      `DESCRIPTION:${escapeText(calendar.description)}`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(calendar.summary)}`,
      "TRIGGER:PT0M",
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
