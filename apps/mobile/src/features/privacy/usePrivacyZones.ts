import { asc, isNull } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { privacyZone } from "@obnixe/schema";
import type { PrivacyZone } from "@obnixe/schema";
import { db } from "@/data/database";

/** Zones in force, oldest first; trashed zones no longer mask anything. */
export function usePrivacyZones(): readonly PrivacyZone[] {
  const { data } = useLiveQuery(db().select().from(privacyZone).where(isNull(privacyZone.deletedAt)).orderBy(asc(privacyZone.createdAt)));
  return data;
}
