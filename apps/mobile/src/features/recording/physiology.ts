import { ageAt, heartRateZones, tanakaMaxHeartRate } from "@obnixe/core";
import type { PhysiologyProfile } from "@obnixe/core";
import type { BiologicalSex, EpochMs } from "@obnixe/schema";
import { formatNumber } from "@/format/numbers";

export const maxHeartRateBounds = { min: 120, max: 230 } as const;

export const oldestBirthYear = 1920;
export const youngestAge = 10;

export const sexLabels: Readonly<Record<BiologicalSex, string>> = { female: "Femme", male: "Homme" };

export type MaxHeartRate =
  | { readonly kind: "entered"; readonly bpm: number }
  | { readonly kind: "estimated"; readonly bpm: number; readonly age: number }
  | { readonly kind: "unknown" };

/** `CAL-004`: the entered maximum wins over the Tanaka estimate of the birth year. */
export function maxHeartRateFrom(profile: PhysiologyProfile, at: EpochMs): MaxHeartRate {
  if (profile.maxHeartRate !== null) return { kind: "entered", bpm: profile.maxHeartRate };
  if (profile.birthYear === null) return { kind: "unknown" };
  const age = ageAt(profile.birthYear, at);
  return { kind: "estimated", bpm: tanakaMaxHeartRate(age), age };
}

export function maxHeartRateDetail(max: MaxHeartRate): string {
  switch (max.kind) {
    case "entered":
      return "Saisie par toi";
    case "estimated":
      return `Estimée à ${max.age} ans : 208 − 0,7 × âge`;
    case "unknown":
      return "Renseigne ton année de naissance ou saisis-la";
    default: {
      const unreachable: never = max;
      return unreachable;
    }
  }
}

export function youngestBirthYear(at: EpochMs): number {
  return new Date(at).getUTCFullYear() - youngestAge;
}

export interface ZoneLine {
  readonly zone: number;
  readonly label: string;
  readonly bpm: string;
}

export function zoneLines(maxHeartRate: number): readonly ZoneLine[] {
  return heartRateZones(maxHeartRate).map(({ zone, minBpm, maxBpm }) => ({
    zone,
    label: `Z${zone} · ${40 + 10 * zone} à ${50 + 10 * zone} %`,
    bpm: `${formatNumber(Math.round(minBpm), 0)}–${formatNumber(Math.round(maxBpm), 0)}`,
  }));
}
