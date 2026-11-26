import { sports } from "@obnixe/schema";
import type { FieldValues, MetricKey, RecordingProfile, SportDefinition, SportKey } from "@obnixe/schema";

export interface ResolvedProfile extends RecordingProfile {
  readonly sport: SportKey;
  /** `REC-060`: no position is recorded; the time between the marks is the moving time. */
  readonly stopwatch: boolean;
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
  return { ...base, ...override, sport, stopwatch: false };
}

const stopwatchMetrics: readonly MetricKey[] = ["moving", "elapsed", "heart_rate", "heart_rate_max", "heart_rate_zone", "clock"];

/**
 * `REC-060`: the profile of a stopwatch-only recording, for an option that records no track (indoor ride, pool swim) or a
 * refused location. The sport's profile keeps its pace unit and splits; it measures the time between the marks and the
 * heart rate the sport shows, without automatic pause. `null` for a sport that records nothing.
 */
export function stopwatchProfile(sport: SportKey, values: FieldValues): ResolvedProfile | null {
  const definition: SportDefinition = sports[sport];
  const base = definition.recording;
  if (base === null) return null;
  const overrides = definition.recordingOverrides;
  const option = overrides === null ? undefined : values[overrides.field];
  const override = overrides === null || typeof option !== "string" ? undefined : (overrides.byOption[option] ?? undefined);
  const profile: RecordingProfile = { ...base, ...override };
  const metrics = stopwatchMetrics.filter((key) => key === "moving" || key === "elapsed" || profile.metrics.includes(key));
  return {
    ...profile,
    sport,
    stopwatch: true,
    autoPauseDefault: false,
    cadence: "none",
    metrics,
    readout: { main: "moving", secondary: metrics.filter((key) => key === "elapsed" || key === "heart_rate" || key === "clock") },
    bestEffortMeters: [],
    bestAscentWindowMs: null,
    climbMinimumAscentMeters: null,
    descentMinimumMeters: null,
    recordedValues: {},
  };
}
