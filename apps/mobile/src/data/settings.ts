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

export interface RecordingDisplay {
  /** `UX-004`. */
  readonly keepScreenOn: boolean;
  /** `REC-013`. */
  readonly countdown: boolean;
}

export function useRecordingDisplay(): RecordingDisplay {
  const { data } = useLiveQuery(db().select({ keepScreenOn: settings.keepScreenOn, countdown: settings.countdown }).from(settings));
  return { keepScreenOn: data[0]?.keepScreenOn ?? false, countdown: data[0]?.countdown ?? false };
}
