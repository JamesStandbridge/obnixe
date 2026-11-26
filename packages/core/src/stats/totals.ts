import type { LocalDate } from "@obnixe/schema";
import { addDays, addMonths, dateParts, localDate, mondayOf, monthEnd, monthOf, monthStart } from "../dates.ts";
import type { SessionSummary } from "./sessions.ts";

export const totalsPeriods = ["week", "month", "year"] as const;
export type TotalsPeriod = (typeof totalsPeriods)[number];

/** `SUM-011`, `CAL-005`: the activities of one period, recorded and logged by hand alike. */
export interface PeriodTotal {
  readonly from: LocalDate;
  readonly to: LocalDate;
  readonly count: number;
  readonly distanceMeters: number;
  readonly movingSeconds: number;
  readonly ascentMeters: number;
  readonly energyKcal: number;
  /** Activities of the period without an energy estimate, so the energy total is a lower bound when it is not zero. */
  readonly withoutEnergy: number;
}

interface PeriodBounds {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

function boundsOf(date: LocalDate, period: TotalsPeriod): PeriodBounds {
  switch (period) {
    case "week": {
      const monday = mondayOf(date);
      return { from: monday, to: addDays(monday, 6) };
    }
    case "month": {
      const month = monthOf(date);
      return { from: monthStart(month), to: monthEnd(month) };
    }
    case "year": {
      const { year } = dateParts(date);
      return { from: localDate(year, 1, 1), to: localDate(year, 12, 31) };
    }
    default: {
      const unreachable: never = period;
      return unreachable;
    }
  }
}

function previousStart(bounds: PeriodBounds, period: TotalsPeriod): LocalDate {
  switch (period) {
    case "week":
      return addDays(bounds.from, -7);
    case "month":
      return monthStart(addMonths(monthOf(bounds.from), -1));
    case "year":
      return localDate(dateParts(bounds.from).year - 1, 1, 1);
    default: {
      const unreachable: never = period;
      return unreachable;
    }
  }
}

interface ActivityTotals {
  readonly distanceMeters: number;
  readonly movingSeconds: number;
  readonly ascentMeters: number;
  readonly energyKcal: number | null;
}

/** The measured totals of a recorded activity, the logged values otherwise (`values.distance`, the duration, `values.elevation_gain`). */
function totalsOf(summary: SessionSummary): ActivityTotals {
  const measured = summary.recording;
  if (measured !== null) {
    return { distanceMeters: measured.distanceMm / 1000, movingSeconds: measured.movingMs / 1000, ascentMeters: (measured.ascentMm ?? 0) / 1000, energyKcal: measured.energyKcal };
  }
  const { distance, elevation_gain: ascent } = summary.values;
  return { distanceMeters: typeof distance === "number" ? distance : 0, movingSeconds: summary.durationSeconds ?? 0, ascentMeters: typeof ascent === "number" ? ascent : 0, energyKcal: null };
}

/** The last `periods` periods up to the one of `today`, oldest first, over `sessions` already narrowed to one sport. */
export function periodTotals(sessions: readonly SessionSummary[], period: TotalsPeriod, today: LocalDate, periods: number): readonly PeriodTotal[] {
  const ranges: PeriodBounds[] = [];
  let bounds = boundsOf(today, period);
  for (let index = 0; index < periods; index += 1) {
    ranges.unshift(bounds);
    bounds = boundsOf(previousStart(bounds, period), period);
  }
  return ranges.map(({ from, to }): PeriodTotal => {
    let count = 0;
    let distanceMeters = 0;
    let movingSeconds = 0;
    let ascentMeters = 0;
    let energyKcal = 0;
    let withoutEnergy = 0;
    for (const summary of sessions) {
      if (summary.localDate < from || summary.localDate > to) continue;
      const totals = totalsOf(summary);
      count += 1;
      distanceMeters += totals.distanceMeters;
      movingSeconds += totals.movingSeconds;
      ascentMeters += totals.ascentMeters;
      if (totals.energyKcal === null) withoutEnergy += 1;
      else energyKcal += totals.energyKcal;
    }
    return { from, to, count, distanceMeters, movingSeconds, ascentMeters, energyKcal, withoutEnergy };
  });
}
