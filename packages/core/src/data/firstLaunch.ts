import { session, sportPreference } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";

export interface LaunchCounts {
  readonly sportPreferences: number;
  readonly sessions: number;
}

/** The welcome flow always records sport preferences and any restored backup brings sessions, so either one means the phone was set up. */
export function isFirstLaunch(counts: LaunchCounts): boolean {
  return counts.sportPreferences === 0 && counts.sessions === 0;
}

export function launchCounts(db: ObnixeDatabase): LaunchCounts {
  return {
    sportPreferences: db.select({ sport: sportPreference.sport }).from(sportPreference).limit(1).all().length,
    sessions: db.select({ id: session.id }).from(session).limit(1).all().length,
  };
}
