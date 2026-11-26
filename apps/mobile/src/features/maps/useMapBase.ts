import { useMemo } from "react";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import { settings } from "@obnixe/schema";
import type { MapStyle, SportKey } from "@obnixe/schema";
import { db } from "@/data/database";
import { blankStyle, emphasisOf, resolveMapBase } from "@/features/maps/styles";
import type { MapBase } from "@/features/maps/styles";
import { useTheme } from "@/ui/theme";

export interface ThemedMapBase extends MapBase {
  readonly fallback: StyleSpecification;
}

export function useMapStyleSetting(): MapStyle {
  const { data } = useLiveQuery(db().select({ mapStyle: settings.mapStyle }).from(settings));
  return data[0]?.mapStyle ?? "obnixe_outdoor";
}

/** The base map chosen in the settings, in the current theme; memoized because a new style object reloads the map. */
export function useMapBase(sport: SportKey | null): ThemedMapBase {
  const mapStyle = useMapStyleSetting();
  const { name } = useTheme();
  const emphasis = emphasisOf(sport);
  return useMemo(() => ({ ...resolveMapBase({ mapStyle, variant: name, emphasis }), fallback: blankStyle(name) }), [mapStyle, name, emphasis]);
}
