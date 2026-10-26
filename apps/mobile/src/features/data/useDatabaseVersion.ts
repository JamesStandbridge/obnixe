import { useEffect, useState } from "react";
import { addDatabaseChangeListener } from "expo-sqlite";

/** Increments whenever one of the given tables changes, to recompute synchronous core reads. */
export function useDatabaseVersion(tables: readonly string[]): number {
  const [version, setVersion] = useState(0);
  const key = tables.join(",");
  useEffect(() => {
    const watched = new Set(key.split(","));
    const subscription = addDatabaseChangeListener((event) => {
      if (watched.has(event.tableName)) setVersion((current) => current + 1);
    });
    return () => subscription.remove();
  }, [key]);
  return version;
}
