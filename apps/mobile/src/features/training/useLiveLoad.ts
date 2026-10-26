import { useEffect, useMemo, useState } from "react";
import type { DependencyList } from "react";
import { addDatabaseChangeListener } from "expo-sqlite";

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

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
