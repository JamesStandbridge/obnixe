import { useEffect, useMemo, useState } from "react";
import type { DependencyList } from "react";
import { AppState } from "react-native";
import { addDatabaseChangeListener } from "expo-sqlite";
import { localDateOf } from "@obnixe/core";
import type { EpochMs, LocalDate } from "@obnixe/schema";
import { environment } from "@/data/database";
import { deviceTimeZone } from "@/format/dates";

export type WatchedTable =
  | "agent_connection"
  | "change"
  | "changeset"
  | "check_in"
  | "exercise"
  | "exercise_zone"
  | "pain_report"
  | "program"
  | "program_item"
  | "program_slot"
  | "program_variant"
  | "program_version"
  | "rotation_skip"
  | "session"
  | "session_item"
  | "settings"
  | "sport_preference"
  | "strength_entry"
  | "strength_set"
  | "weigh_in"
  | "zone_tracking";

export function useLiveValue<T>(compute: () => T, tables: readonly WatchedTable[], deps: DependencyList): T {
  const [version, setVersion] = useState(0);
  const key = tables.join(",");
  useEffect(() => {
    const watched = new Set<string>(key.split(","));
    const subscription = addDatabaseChangeListener(({ tableName }) => {
      if (watched.has(tableName)) setVersion((value) => value + 1);
    });
    return () => subscription.remove();
  }, [key]);
  return useMemo(compute, [version, ...deps]);
}

export interface LocalNow {
  readonly today: LocalDate;
  readonly now: EpochMs;
  readonly timeZone: string;
}

function readNow(): LocalNow {
  const now = environment.now();
  const timeZone = deviceTimeZone();
  return { today: localDateOf(now, timeZone), now, timeZone };
}

export function useLocalNow(): LocalNow {
  const [value, setValue] = useState(readNow);
  useEffect(() => {
    const refresh = (): void => {
      setValue((previous) => {
        const next = readNow();
        return next.today === previous.today ? previous : next;
      });
    };
    const timer = setInterval(refresh, 60_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  return value;
}
