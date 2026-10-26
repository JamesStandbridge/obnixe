import type { EpochMs, LocalDate } from "@obnixe/schema";
import { addDays, weekdayIndex } from "../dates.ts";
import type { WeekdayIndex } from "../dates.ts";

/** `settings.reminderWeekdays` is a bit mask: bit 0 is Monday, bit 6 is Sunday. */
export const weekdayCodes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export const weekdayIndexes: readonly WeekdayIndex[] = [0, 1, 2, 3, 4, 5, 6];

export function weekdaysOf(mask: number): readonly WeekdayIndex[] {
  return weekdayIndexes.filter((day) => (mask & (1 << day)) !== 0);
}

export function toggleWeekday(mask: number, day: WeekdayIndex): number {
  return mask ^ (1 << day);
}

export class EmptyReminderError extends Error {
  constructor() {
    super("A reminder needs at least one weekday");
  }
}

export interface ReminderCalendarRequest {
  readonly weekdays: number;
  readonly minutes: number;
  readonly from: LocalDate;
  readonly now: EpochMs;
  readonly uid: string;
  readonly title: string;
}

const pad = (value: number, length = 2): string => String(value).padStart(length, "0");

function utcStamp(instant: EpochMs): string {
  const date = new Date(instant);
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Builds an iCalendar file with one weekly recurring event in floating local time, so the phone's own time zone applies. */
export function remindersCalendar(request: ReminderCalendarRequest): string {
  const days = weekdaysOf(request.weekdays);
  if (days.length === 0) throw new EmptyReminderError();
  const start = weekdayIndex(request.from);
  const offset = Math.min(...days.map((day) => (day - start + 7) % 7));
  const time = `${pad(Math.floor(request.minutes / 60))}${pad(request.minutes % 60)}00`;
  const title = escapeText(request.title);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Obnixe//Rappels//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${request.uid}@obnixe`,
    `DTSTAMP:${utcStamp(request.now)}`,
    `DTSTART:${addDays(request.from, offset).replaceAll("-", "")}T${time}`,
    "DURATION:PT1H",
    `RRULE:FREQ=WEEKLY;BYDAY=${days.map((day) => weekdayCodes[day]).join(",")}`,
    `SUMMARY:${title}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:PT0M",
    `DESCRIPTION:${title}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
