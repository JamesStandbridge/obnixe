import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { EpochMs } from "@obnixe/schema";
import { dayMonth, fileSize } from "@/features/data/format";
import { MapButton } from "@/features/maps/MapControls";
import { MapSurface } from "@/features/maps/MapSurface";
import { useNativeFailure } from "@/features/maps/nativeFailure";
import { downloadOfflineRegion, useOfflineRegions } from "@/features/maps/offline";
import type { MapCamera, MapView } from "@/features/maps/surface";
import { estimateRegion, maxRegionTiles } from "@/features/maps/tiles";
import type { RegionEstimate } from "@/features/maps/tiles";
import { useMapBase, useMapStyleSetting } from "@/features/maps/useMapBase";
import { formatInteger } from "@/format/numbers";
import { PrimaryButton } from "@/ui/Button";
import { TextField } from "@/ui/Inputs";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { layout } from "@/ui/tokens";

const franceOverview: MapCamera = { center: [2.4, 46.6], zoom: 5.4 };

function estimateLabel(view: MapView | null, estimate: RegionEstimate | null): string {
  if (view === null || estimate === null) return "Déplace la carte sur la zone à garder";
  if (estimate.tiles > maxRegionTiles) return "Zone trop grande : rapproche-toi pour la réduire";
  return `Environ ${fileSize(estimate.bytes)} · ${formatInteger(estimate.tiles)} tuiles`;
}

/** Picks the visible rectangle as a new offline region, with its size estimated before download (MAP-031). */
export function OfflineRegionScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const base = useMapBase(null);
  const mapStyle = useMapStyleSetting();
  const regions = useOfflineRegions();
  const run = useNativeFailure();
  const [now] = useState(() => Date.now() as EpochMs);
  const [name, setName] = useState(() => `Région du ${dayMonth(now)}`);
  const [view, setView] = useState<MapView | null>(null);
  const [initialCamera] = useState<MapCamera>(() => {
    const latest = regions[0];
    if (latest === undefined) return franceOverview;
    const [west, south, east, north] = latest.bounds;
    return { center: [(west + east) / 2, (south + north) / 2], zoom: 9 };
  });

  const estimate = useMemo(() => (view === null ? null : estimateRegion(view.bounds, base.offline)), [view, base.offline]);
  const ready = view !== null && estimate !== null && estimate.tiles <= maxRegionTiles && name.trim().length > 0;

  const download = (): void => {
    if (view === null) return;
    run(downloadOfflineRegion({ name: name.trim(), bounds: view.bounds, mapStyle }, now), "Téléchargement impossible");
    router.back();
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={styles.map}>
        <MapSurface mapStyle={base.style} fallbackStyle={base.fallback} initialCamera={initialCamera} onViewChanged={setView} />
        <View pointerEvents="none" style={[styles.frame, { borderColor: colors.mark }]} />
        <View style={[styles.back, { top: insets.top + 8 }]}>
          <MapButton icon="back" label="Retour" onPress={() => (router.canGoBack() ? router.back() : router.replace("/settings/offline-maps"))} />
        </View>
      </View>
      <View style={[styles.panel, { borderTopColor: colors.line, paddingBottom: insets.bottom + 12 }]}>
        <Text variant="heading">Nouvelle région</Text>
        <TextField value={name} onChangeText={setName} placeholder="Nom de la région" accessibilityLabel="Nom de la région" maxLength={60} />
        <Text variant="small" tone="secondary" accessibilityLiveRegion="polite">
          {estimateLabel(view, estimate)}
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
