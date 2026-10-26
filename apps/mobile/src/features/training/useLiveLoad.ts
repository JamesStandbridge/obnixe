import { useEffect, useMemo, useState } from "react";
import type { DependencyList } from "react";
import { addDatabaseChangeListener } from "expo-sqlite";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { settings } from "@obnixe/schema";
import type { MassUnit } from "@obnixe/schema";
import { db } from "@/data/database";

export function useLiveLoad<T>(load: () => T, deps: DependencyList): T {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let scheduled: ReturnType<typeof setTimeout> | null = null;
    const subscription = addDatabaseChangeListener(() => {
      if (scheduled !== null) return;
      scheduled = setTimeout(() => {
        scheduled = null;
        setRevision((current) => current + 1);
      }, 0);
    });
    return () => {
      subscription.remove();
      if (scheduled !== null) clearTimeout(scheduled);
    };
  }, []);
  return useMemo(load, [revision, ...deps]);
}

export function useMassUnit(): MassUnit {
  const { data } = useLiveQuery(db().select({ massUnit: settings.massUnit }).from(settings));
  return data[0]?.massUnit ?? "kg";
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function deviceTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return /^(UTC|[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2})$/.test(zone) ? zone : "UTC";
}
