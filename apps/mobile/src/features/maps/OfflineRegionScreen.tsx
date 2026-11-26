import { useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { EpochMs, Id } from "@obnixe/schema";
import { db } from "@/data/database";
import { dayMonth, fileSize } from "@/features/data/format";
import { activityArea, activityRegionBounds, activityRegionMargins, regionOutline, regionOutlineLayers, regionOutlineSourceId } from "@/features/maps/activityRegion";
import type { ActivityArea, ActivityRegionMargin } from "@/features/maps/activityRegion";
import { MapButton } from "@/features/maps/MapControls";
import { MapSurface } from "@/features/maps/MapSurface";
import { useNativeFailure } from "@/features/maps/nativeFailure";
import { downloadOfflineRegion, useOfflineRegions } from "@/features/maps/offline";
import type { MapCamera, MapOverlay, MapSurfaceHandle, MapView } from "@/features/maps/surface";
import { estimateRegion, maxRegionTiles } from "@/features/maps/tiles";
import type { Bounds, RegionEstimate } from "@/features/maps/tiles";
import { useMapBase, useMapStyleSetting } from "@/features/maps/useMapBase";
import { fitCamera } from "@/features/maps/viewport";
import type { ViewSize } from "@/features/maps/viewport";
import { formatInteger } from "@/format/numbers";
import { PrimaryButton } from "@/ui/Button";
import { Segmented } from "@/ui/Controls";
import { TextField } from "@/ui/Inputs";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { layout } from "@/ui/tokens";

const franceOverview: MapCamera = { center: [2.4, 46.6], zoom: 5.4 };

const regionPadding = 28;
const maxRegionZoom = 14;

const marginOptions: readonly { readonly value: ActivityRegionMargin; readonly label: string }[] = activityRegionMargins.map((margin) => ({ value: margin, label: `${margin} km` }));

function estimateLabel(bounds: Bounds | null, estimate: RegionEstimate | null, around: boolean): string {
  if (bounds === null || estimate === null) return "Déplace la carte sur la zone à garder";
  if (estimate.tiles > maxRegionTiles) return around ? "Zone trop grande : réduis la marge" : "Zone trop grande : rapproche-toi pour la réduire";
  return `Environ ${fileSize(estimate.bytes)} · ${formatInteger(estimate.tiles)} tuiles`;
}

interface OfflineRegionScreenProps {
  /** Frames the region on this recorded activity, widened by an adjustable margin, instead of the visible rectangle. */
  readonly sessionId: Id | null;
}

/** Picks the visible rectangle, or the area around an activity, as a new offline region, with its size estimated before download (MAP-031). */
export function OfflineRegionScreen({ sessionId }: OfflineRegionScreenProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const base = useMapBase(null);
  const mapStyle = useMapStyleSetting();
  const regions = useOfflineRegions();
  const run = useNativeFailure();
  const [now] = useState(() => Date.now() as EpochMs);
  const [area] = useState<ActivityArea | null>(() => (sessionId === null ? null : activityArea(db(), sessionId)));
  const [name, setName] = useState(() => (area === null ? `Région du ${dayMonth(now)}` : `Autour de ${area.title}`));
  const [margin, setMargin] = useState<ActivityRegionMargin>("2");
  const [view, setView] = useState<MapView | null>(null);
  const [areaCamera, setAreaCamera] = useState<MapCamera | null>(null);
  const size = useRef<ViewSize | null>(null);
  const surface = useRef<MapSurfaceHandle>(null);
  const [initialCamera] = useState<MapCamera>(() => {
    const latest = regions[0];
    if (latest === undefined) return franceOverview;
    const [west, south, east, north] = latest.bounds;
    return { center: [(west + east) / 2, (south + north) / 2], zoom: 9 };
  });

  const areaBounds = useMemo(() => (area === null ? null : activityRegionBounds(area, margin)), [area, margin]);
  const bounds = area === null ? (view?.bounds ?? null) : areaBounds;
  const estimate = useMemo(() => (bounds === null ? null : estimateRegion(bounds, base.offline)), [bounds, base.offline]);
  const ready = bounds !== null && estimate !== null && estimate.tiles <= maxRegionTiles && name.trim().length > 0;
  const overlays = useMemo<MapOverlay[]>(
    () => (areaBounds === null ? [] : [{ id: regionOutlineSourceId, data: regionOutline(areaBounds), lineMetrics: false, layers: regionOutlineLayers(colors.mark) }]),
    [areaBounds, colors.mark],
  );

  const onLayout = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    size.current = { width, height };
    if (areaCamera === null && areaBounds !== null) setAreaCamera(fitCamera(areaBounds, size.current, regionPadding, maxRegionZoom));
  };

  const chooseMargin = (next: ActivityRegionMargin): void => {
    setMargin(next);
    const nextBounds = area === null ? null : activityRegionBounds(area, next);
    if (nextBounds === null || size.current === null) return;
    const camera = fitCamera(nextBounds, size.current, regionPadding, maxRegionZoom);
    surface.current?.moveTo({ center: camera.center, zoom: camera.zoom, durationMs: 400 });
  };

  const download = (): void => {
    if (bounds === null) return;
    run(downloadOfflineRegion({ name: name.trim(), bounds, mapStyle }, now), "Téléchargement impossible");
    router.back();
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={styles.map} onLayout={onLayout}>
        {area === null ? (
          <MapSurface mapStyle={base.style} fallbackStyle={base.fallback} initialCamera={initialCamera} onViewChanged={setView} />
        ) : areaCamera === null ? null : (
          <MapSurface ref={surface} mapStyle={base.style} fallbackStyle={base.fallback} initialCamera={areaCamera} overlays={overlays} />
        )}
        {area === null ? <View pointerEvents="none" style={[styles.frame, { borderColor: colors.mark }]} /> : null}
        <View style={[styles.back, { top: insets.top + 8 }]}>
          <MapButton icon="back" label="Retour" onPress={() => (router.canGoBack() ? router.back() : router.replace("/settings/offline-maps"))} />
        </View>
      </View>
      <View style={[styles.panel, { borderTopColor: colors.line, paddingBottom: insets.bottom + 12 }]}>
        <Text variant="heading">{area === null ? "Nouvelle région" : "Autour de l'activité"}</Text>
        <TextField value={name} onChangeText={setName} placeholder="Nom de la région" accessibilityLabel="Nom de la région" maxLength={60} />
        {area === null ? null : (
          <View accessibilityLabel="Marge autour de la trace">
            <Segmented<ActivityRegionMargin> options={marginOptions} value={margin} onChange={chooseMargin} />
          </View>
        )}
        <Text variant="small" tone="secondary" accessibilityLiveRegion="polite">
          {estimateLabel(bounds, estimate, area !== null)}
        </Text>
        <PrimaryButton label="Télécharger" disabled={!ready} onPress={download} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  map: { flex: 1, overflow: "hidden" },
  frame: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, borderWidth: 2 },
  back: { position: "absolute", left: layout.gutter },
  panel: { borderTopWidth: 1, paddingTop: 16, paddingHorizontal: layout.gutter, gap: 12 },
});
