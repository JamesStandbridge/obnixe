import { StyleSheet, View } from "react-native";
import { AttributionButton } from "@/features/maps/MapControls";
import { MapSurface } from "@/features/maps/MapSurface";
import { useMapBase } from "@/features/maps/useMapBase";
import { useTheme } from "@/ui/theme";
import { radii } from "@/ui/tokens";

/** Chamonix valley under the Mont Blanc: relief, glaciers, trails, huts and summits in one frame. */
const previewCamera = { center: [6.885, 45.918] as const, zoom: 11.6 };

/** Still preview of the chosen base map in the current theme. */
export function MapPreview() {
  const { colors } = useTheme();
  const base = useMapBase(null);
  return (
    <View style={[styles.frame, { borderColor: colors.line, backgroundColor: colors.surface }]}>
      <MapSurface mapStyle={base.style} fallbackStyle={base.fallback} initialCamera={previewCamera} interactive={false} />
      <View style={styles.attribution}>
        <AttributionButton attribution={base.attribution} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { height: 210, marginTop: 12, borderRadius: radii.panel, borderWidth: 1, overflow: "hidden" },
  attribution: { position: "absolute", right: 8, bottom: 8 },
});
