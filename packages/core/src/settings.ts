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

type SettingsField = keyof SettingsPatch;

const localOnlyFields: ReadonlySet<SettingsField> = new Set<SettingsField>(["bridgeHost", "restAlertsDeclinedAt", "restAlertsAskedAt"]);

/**
 * Settings is a device-local singleton outside the journal: writes are direct and never undoable.
 * `updatedAt` decides which side wins a backup merge, so it only moves when a field that travels with backups changes.
 */
export function updateSettings(db: ObnixeDatabase, patch: SettingsPatch, now: EpochMs): void {
  const current = db.select().from(settings).get();
  if (current === undefined) return;
  const changed = (Object.keys(patch) as SettingsField[]).filter((field) => patch[field] !== undefined && patch[field] !== current[field]);
  if (changed.length === 0) return;
  const values = Object.fromEntries(changed.map((field) => [field, patch[field]])) as SettingsPatch;
  const synced = changed.some((field) => !localOnlyFields.has(field));
  db.update(settings)
    .set(synced ? { ...values, updatedAt: now } : values)
    .run();
}
