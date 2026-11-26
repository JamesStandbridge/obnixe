import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import type { Route } from "@obnixe/schema";
import { offlineMapsAvailable, useOfflineRegions } from "@/features/maps/offline";
import { coversBounds } from "@/features/maps/offlineRegions";
import type { Bounds } from "@/features/maps/tiles";
import { useMapStyleSetting } from "@/features/maps/useMapBase";
import { LinkButton } from "@/ui/Button";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { radii } from "@/ui/tokens";

function boundsOf(row: Pick<Route, "bbox">): Bounds {
  const { west, south, east, north } = row.bbox;
  return [west / 1e7, south / 1e7, east / 1e7, north / 1e7];
}

interface RouteOfflineHintProps {
  readonly route: Pick<Route, "id" | "bbox">;
}

/** `RTE-006`: offers the region 2 km around a route whose area is not available offline (`MAP-031`). */
export function RouteOfflineHint({ route }: RouteOfflineHintProps) {
  const { colors } = useTheme();
  const regions = useOfflineRegions();
  const mapStyle = useMapStyleSetting();
  if (!offlineMapsAvailable || coversBounds(regions, boundsOf(route), mapStyle)) return null;
  return (
    <View style={[styles.hint, { backgroundColor: colors.surface, borderColor: colors.line }]}>
      <Text variant="small" tone="secondary">
        La carte de cet itinéraire n'est pas disponible hors ligne.
      </Text>
      <LinkButton label="Télécharger la zone (2 km autour)" onPress={() => router.push({ pathname: "/settings/offline-region", params: { route: route.id } })} style={styles.link} />
    </View>
  );
}

const styles = StyleSheet.create({
  hint: { marginTop: 8, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4, gap: 2, borderRadius: radii.panel, borderWidth: 1 },
  link: { alignSelf: "flex-start", marginLeft: -10 },
});
