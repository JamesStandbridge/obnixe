import { useEffect } from "react";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { OfflineManager } from "@maplibre/maplibre-react-native";
import { settings } from "@obnixe/schema";
import { db } from "@/data/database";

/** Caps MapLibre's ambient tile cache to the size chosen in the settings (MAP-030). */
export function MapCacheHost() {
  const { data } = useLiveQuery(db().select({ megabytes: settings.mapCacheMegabytes }).from(settings));
  const megabytes = data[0]?.megabytes;
  useEffect(() => {
    if (megabytes !== undefined) void OfflineManager.setMaximumAmbientCacheSize(megabytes * 1024 * 1024);
  }, [megabytes]);
  return null;
}
