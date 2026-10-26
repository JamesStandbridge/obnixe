import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { updateSettings as writeSettings } from "@obnixe/core";
import type { SettingsPatch } from "@obnixe/core";
import { settings } from "@obnixe/schema";
import type { EpochMs, MassUnit } from "@obnixe/schema";
import { db, environment } from "@/data/database";

export function updateSettings(patch: SettingsPatch, now: EpochMs = environment.now()): void {
  writeSettings(db(), patch, now);
}

export function useMassUnit(): MassUnit {
  const { data } = useLiveQuery(db().select({ massUnit: settings.massUnit }).from(settings));
  return data[0]?.massUnit ?? "kg";
}
