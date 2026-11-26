import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import type { SportKey } from "@obnixe/schema";
import type { PreviewPath } from "@/features/activityFiles/importActivity";
import { AttributionButton } from "@/features/maps/MapControls";
import { MapSurface } from "@/features/maps/MapSurface";
import { routeLayers, routeLineData, routeSourceId } from "@/features/maps/routeLayers";
import type { MapOverlay } from "@/features/maps/surface";
import { pointLayers, pointsSourceId } from "@/features/maps/trackLayers";
import { useMapBase } from "@/features/maps/useMapBase";
import { fitCamera } from "@/features/maps/viewport";
import type { ViewSize } from "@/features/maps/viewport";
import { useTheme } from "@/ui/theme";
import { radii } from "@/ui/tokens";

const framePadding = 28;
const frameMaxZoom = 16;
const startLayerId = "obnixe-start";

function startData(path: PreviewPath): string {
  const start = path.coordinates[0];
  const features = start === undefined ? [] : [{ type: "Feature", properties: { kind: "start" }, geometry: { type: "Point", coordinates: start } }];
  return JSON.stringify({ type: "FeatureCollection", features });
}

interface RouteMapProps {
  readonly path: PreviewPath;
  readonly sport: SportKey;
  readonly height: number;
  readonly interactive: boolean;
}

function RouteMapView({ path, sport, interactive, size }: Omit<RouteMapProps, "height"> & { readonly size: ViewSize }) {
  const { name, colors } = useTheme();
  const base = useMapBase(sport);
  const [initialCamera] = useState(() => fitCamera(path.bounds, size, framePadding, frameMaxZoom));
  const overlays = useMemo<MapOverlay[]>(() => {
    const trackColors = { from: colors.sportDeep[sport], to: colors.sport[sport] };
    return [
      { id: routeSourceId, data: routeLineData(path.coordinates), lineMetrics: false, layers: routeLayers(colors.mark, name) },
      { id: pointsSourceId, data: startData(path), lineMetrics: false, layers: pointLayers(trackColors, name).filter((layer) => layer.id === startLayerId) },
    ];
  }, [path, sport, colors, name]);
  return (
    <>
      <MapSurface mapStyle={base.style} fallbackStyle={base.fallback} initialCamera={initialCamera} overlays={overlays} interactive={interactive} />
      <View style={styles.attribution}>
        <AttributionButton attribution={base.attribution} />
      </View>
    </>
  );
}

/** A route on the map with the direction to follow, framed once its size is known (`RTE-001`, `RTE-002`). */
export function RouteMap({ path, sport, height, interactive }: RouteMapProps) {
  const { colors } = useTheme();
  const [size, setSize] = useState<ViewSize | null>(null);
  const measure = (event: LayoutChangeEvent): void => {
    const { width, height: measured } = event.nativeEvent.layout;
    setSize((current) => (current?.width === width && current.height === measured ? current : { width, height: measured }));
  };
  return (
    <View style={[styles.frame, { height, borderColor: colors.line, backgroundColor: colors.surface }]} onLayout={measure} accessibilityLabel="Carte de l'itinéraire">
      {size === null ? null : <RouteMapView key={`${size.width}x${size.height}`} path={path} sport={sport} interactive={interactive} size={size} />}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { marginTop: 14, borderRadius: radii.panel, borderWidth: 1, overflow: "hidden" },
  attribution: { position: "absolute", right: 8, bottom: 8 },
});
