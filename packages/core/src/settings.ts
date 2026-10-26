import { settings } from "@obnixe/schema";
import type { EpochMs, Settings } from "@obnixe/schema";
import type { ObnixeDatabase } from "./database.ts";

export type SettingsValues = Omit<Settings, "singleton">;

export type SettingsPatch = Partial<Omit<Settings, "singleton" | "updatedAt">>;

export class MissingSettingsError extends Error {
  constructor() {
    super("The settings row does not exist");
  }
}

export function readSettings(db: ObnixeDatabase): SettingsValues {
  const row = db.select().from(settings).get();
  if (row === undefined) throw new MissingSettingsError();
  const { singleton: _singleton, ...values } = row;
  return values;
}

/** Settings is a device-local singleton outside the journal: writes are direct and never undoable. */
export function updateSettings(db: ObnixeDatabase, patch: SettingsPatch, now: EpochMs): void {
  db.update(settings)
    .set({ ...patch, updatedAt: now })
    .run();
}
