import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import type { SportKey } from "@obnixe/schema";
import type { PreviewPath } from "@/features/activityFiles/importActivity";
import { AttributionButton } from "@/features/maps/MapControls";
import { MapSurface } from "@/features/maps/MapSurface";
import type { MapOverlay } from "@/features/maps/surface";
import { pointLayers, pointsSourceId, trackLayers, trackSourceId } from "@/features/maps/trackLayers";
import { useMapBase } from "@/features/maps/useMapBase";
import { fitCamera } from "@/features/maps/viewport";
import type { ViewSize } from "@/features/maps/viewport";
import { useTheme } from "@/ui/theme";
import { radii } from "@/ui/tokens";

const framePadding = 24;
const frameMaxZoom = 16;
const startLayerId = "obnixe-start";

function trackGeoJson(path: PreviewPath): string {
  return JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { kind: "track" }, geometry: { type: "LineString", coordinates: path.coordinates } }] });
}

function startGeoJson(path: PreviewPath): string {
  const start = path.coordinates[0];
  const features = start === undefined ? [] : [{ type: "Feature", properties: { kind: "start" }, geometry: { type: "Point", coordinates: start } }];
  return JSON.stringify({ type: "FeatureCollection", features });
}

interface ImportMapProps {
  readonly path: PreviewPath;
  readonly sport: SportKey;
}

function ImportMapView({ path, sport, size }: ImportMapProps & { readonly size: ViewSize }) {
  const { name, colors } = useTheme();
  const base = useMapBase(sport);
  const [initialCamera] = useState(() => fitCamera(path.bounds, size, framePadding, frameMaxZoom));
  const overlays = useMemo<MapOverlay[]>(() => {
    const trackColors = { from: colors.sportDeep[sport], to: colors.sport[sport] };
    return [
      { id: trackSourceId, data: trackGeoJson(path), lineMetrics: true, layers: trackLayers(trackColors, name) },
      { id: pointsSourceId, data: startGeoJson(path), lineMetrics: false, layers: pointLayers(trackColors, name).filter((layer) => layer.id === startLayerId) },
    ];
  }, [path, sport, colors, name]);
  return (
    <>
      <MapSurface mapStyle={base.style} fallbackStyle={base.fallback} initialCamera={initialCamera} overlays={overlays} interactive={false} />
      <View style={styles.attribution}>
        <AttributionButton attribution={base.attribution} />
      </View>
    </>
  );
}

/** Still map of the file's track, framed once its size is known (`IO-010` preview). */
export function ImportMap({ path, sport }: ImportMapProps) {
  const { colors } = useTheme();
  const [size, setSize] = useState<ViewSize | null>(null);
  const measure = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) => (current?.width === width && current.height === height ? current : { width, height }));
  };
  return (
    <View style={[styles.frame, { borderColor: colors.line, backgroundColor: colors.surface }]} onLayout={measure} accessibilityLabel="Carte de l'activité">
      {size === null ? null : <ImportMapView key={`${size.width}x${size.height}`} path={path} sport={sport} size={size} />}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { height: 220, marginTop: 14, borderRadius: radii.panel, borderWidth: 1, overflow: "hidden" },
  attribution: { position: "absolute", right: 8, bottom: 8 },
});
