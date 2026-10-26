import { useEffect, useMemo } from "react";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { isFirstLaunch, launchCounts } from "@obnixe/core";
import { session, sportPreference } from "@obnixe/schema";
import { db } from "@/data/database";
import { runHousekeeping } from "@/features/data/backup";

export interface AppLaunch {
  readonly firstLaunch: boolean;
}

export function useFirstLaunch(): boolean {
  const initial = useMemo(() => launchCounts(db()), []);
  const preferences = useLiveQuery(db().select({ sport: sportPreference.sport }).from(sportPreference).limit(1));
  const sessions = useLiveQuery(db().select({ id: session.id }).from(session).limit(1));
  return isFirstLaunch({
    sportPreferences: preferences.updatedAt === undefined ? initial.sportPreferences : preferences.data.length,
    sessions: sessions.updatedAt === undefined ? initial.sessions : sessions.data.length,
  });
}

/** Tracks the first-launch rule live and purges expired trash once per launch. */
export function useAppLaunch(): AppLaunch {
  const firstLaunch = useFirstLaunch();
  useEffect(() => {
    runHousekeeping();
  }, []);
  return { firstLaunch };
}
