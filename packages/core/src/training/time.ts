import type { EpochMs, Session } from "@obnixe/schema";
import { localTimeOf } from "../activity/dates.ts";
import { addDays } from "../stats/dates.ts";

export const resumeUntilHour = 6;

export function isResumable(session: Pick<Session, "status" | "localDate" | "timeZone">, now: EpochMs): boolean {
  if (session.status === "completed") return false;
  const current = localTimeOf(now, session.timeZone);
  if (current.date <= session.localDate) return true;
  return current.date === addDays(session.localDate, 1) && current.minutes < resumeUntilHour * 60;
}
