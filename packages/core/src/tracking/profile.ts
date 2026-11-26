import { sports } from "@obnixe/schema";
import type { FieldValues, RecordingProfile, SportDefinition, SportKey } from "@obnixe/schema";

export interface ResolvedProfile extends RecordingProfile {
  readonly sport: SportKey;
}

/** The only access point to recording parameters (`SPT-002`): the sport's profile with the override of the chosen option; `null` when the sport or this option records no track. */
export function resolveProfile(sport: SportKey, values: FieldValues): ResolvedProfile | null {
  const definition: SportDefinition = sports[sport];
  const base = definition.recording;
  if (base === null) return null;
  const overrides = definition.recordingOverrides;
  const option = overrides === null ? undefined : values[overrides.field];
  const override = overrides === null || typeof option !== "string" ? undefined : overrides.byOption[option];
  if (override === null) return null;
  return { ...base, ...override, sport };
}
