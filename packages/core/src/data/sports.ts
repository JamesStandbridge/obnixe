import { sportKeys, sports } from "@obnixe/schema";
import type { SportKey, SportPreference } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { currentProgram } from "../rotation.ts";
import type { Mutation } from "../writer.ts";

export interface SportChoice {
  readonly sport: SportKey;
  readonly enabled: boolean;
  readonly position: number;
  readonly persisted: boolean;
}

export class SportLockedError extends Error {
  constructor(readonly sport: SportKey) {
    super(`${sport} is used by the active program`);
  }
}

const isRetired = (sport: SportKey): boolean => "retired" in sports[sport];

/** Every catalog sport in display order: enabled ones by position, then the rest in catalog order. Retired sports only appear while enabled. */
export function sportChoices(preferences: readonly SportPreference[]): readonly SportChoice[] {
  const bySport = new Map(preferences.map((preference) => [preference.sport, preference]));
  const catalogIndex = new Map(sportKeys.map((sport, index) => [sport, index]));
  return sportKeys
    .filter((sport) => !isRetired(sport) || bySport.get(sport)?.enabled === true)
    .map((sport): SportChoice => {
      const preference = bySport.get(sport);
      return { sport, enabled: preference?.enabled ?? false, position: preference?.position ?? Number.MAX_SAFE_INTEGER, persisted: preference !== undefined };
    })
    .sort((left, right) => Number(right.enabled) - Number(left.enabled) || left.position - right.position || (catalogIndex.get(left.sport) ?? 0) - (catalogIndex.get(right.sport) ?? 0));
}

export function enabledSports(preferences: readonly SportPreference[]): readonly SportKey[] {
  return sportChoices(preferences)
    .filter((choice) => choice.enabled)
    .map((choice) => choice.sport);
}

export function lockedSports(db: ObnixeDatabase): ReadonlySet<SportKey> {
  const current = currentProgram(db);
  return new Set(current === null ? [] : current.slots.map((slot) => slot.sport));
}

function mutationsFor(before: readonly SportChoice[], after: readonly SportChoice[]): Mutation[] {
  const previous = new Map(before.map((choice) => [choice.sport, choice]));
  const mutations: Mutation[] = [];
  for (const choice of after) {
    const old = previous.get(choice.sport);
    if (old === undefined || !old.persisted) {
      mutations.push({ kind: "insert", table: "sport_preference", row: { sport: choice.sport, enabled: choice.enabled, position: choice.position } });
    } else if (old.enabled !== choice.enabled || old.position !== choice.position) {
      mutations.push({ kind: "update", table: "sport_preference", key: choice.sport, patch: { enabled: choice.enabled, position: choice.position } });
    }
  }
  return mutations;
}

function renumbered(ordered: readonly Omit<SportChoice, "position">[]): readonly SportChoice[] {
  return ordered.map((choice, position) => ({ ...choice, position }));
}

export function setSportEnabledMutations(preferences: readonly SportPreference[], sport: SportKey, enabled: boolean, locked: ReadonlySet<SportKey>): Mutation[] {
  if (!enabled && locked.has(sport)) throw new SportLockedError(sport);
  const before = sportChoices(preferences);
  const target = before.find((choice) => choice.sport === sport);
  if (target === undefined || (target.enabled === enabled && target.persisted)) return [];
  const others = before.filter((choice) => choice.sport !== sport);
  const enabledCount = others.filter((choice) => choice.enabled).length;
  const ordered = [...others.slice(0, enabledCount), { ...target, enabled }, ...others.slice(enabledCount)];
  return mutationsFor(before, renumbered(ordered));
}

export function moveSportMutations(preferences: readonly SportPreference[], sport: SportKey, offset: -1 | 1): Mutation[] {
  const before = sportChoices(preferences);
  const index = before.findIndex((choice) => choice.sport === sport);
  const swapWith = index + offset;
  const target = before[index];
  const neighbour = before[swapWith];
  if (target === undefined || neighbour === undefined || !target.enabled || !neighbour.enabled) return [];
  const ordered = [...before];
  ordered[index] = neighbour;
  ordered[swapWith] = target;
  return mutationsFor(before, renumbered(ordered));
}

/** Records every sport once, in the offered order with the selected ones first; sports missing from `offered` follow in catalog order. */
export function initialSportMutations(offered: readonly SportKey[], selected: ReadonlySet<SportKey>): Mutation[] {
  const all = [...offered, ...sportKeys.filter((sport) => !offered.includes(sport) && !isRetired(sport))];
  const ordered = [...all.filter((sport) => selected.has(sport)), ...all.filter((sport) => !selected.has(sport))];
  return ordered.map((sport, position) => ({ kind: "insert", table: "sport_preference", row: { sport, enabled: selected.has(sport), position } }));
}
