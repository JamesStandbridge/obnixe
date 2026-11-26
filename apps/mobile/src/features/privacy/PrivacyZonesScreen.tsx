import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import { router } from "expo-router";
import { effectiveRadiusMeters } from "@obnixe/core";
import type { PrivacyZone } from "@obnixe/schema";
import { BackButton, BottomPanel, Chevron } from "@/features/data/parts";
import { AttributionButton } from "@/features/maps/MapControls";
import { MapSurface } from "@/features/maps/MapSurface";
import type { MapOverlay } from "@/features/maps/surface";
import { useMapBase } from "@/features/maps/useMapBase";
import { fitCamera } from "@/features/maps/viewport";
import type { ViewSize } from "@/features/maps/viewport";
import { usePrivacyZones } from "@/features/privacy/usePrivacyZones";
import { privacyZoneLayers, privacyZonesSourceId, zonesBounds, zonesGeoJson } from "@/features/privacy/zoneShapes";
import { formatInteger } from "@/format/numbers";
import { PrimaryButton } from "@/ui/Button";
import { AppBar, Row, Screen, Section } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { radii } from "@/ui/tokens";

const overviewPadding = 28;
const overviewMaxZoom = 15;

interface ZonesMapProps {
  readonly zones: readonly PrivacyZone[];
  readonly size: ViewSize;
}

function ZonesMap({ zones, size }: ZonesMapProps) {
  const { colors } = useTheme();
  const base = useMapBase(null);
  const [initialCamera] = useState(() => {
    const bounds = zonesBounds(zones);
    return bounds === null ? { center: [2.4, 46.6] as const, zoom: 5 } : fitCamera(bounds, size, overviewPadding, overviewMaxZoom);
  });
  const overlays = useMemo<MapOverlay[]>(() => [{ id: privacyZonesSourceId, data: zonesGeoJson(zones), lineMetrics: false, layers: privacyZoneLayers(colors.mark) }], [zones, colors.mark]);
  return (
    <>
      <MapSurface mapStyle={base.style} fallbackStyle={base.fallback} initialCamera={initialCamera} overlays={overlays} interactive={false} />
      <View style={styles.attribution}>
        <AttributionButton attribution={base.attribution} />
      </View>
    </>
  );
}

interface ZonesOverviewProps {
  readonly zones: readonly PrivacyZone[];
}

/** Every masked area on one still map, framed again whenever a zone moves or changes size. */
function ZonesOverview({ zones }: ZonesOverviewProps) {
  const { colors } = useTheme();
  const [size, setSize] = useState<ViewSize | null>(null);
  const framing = zones.map((zone) => `${zone.id}:${zone.latitudeE7}:${zone.longitudeE7}:${zone.radiusMeters}`).join(",");
  const measure = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) => (current?.width === width && current.height === height ? current : { width, height }));
  };
  return (
    <View style={[styles.frame, { borderColor: colors.line, backgroundColor: colors.surface }]} onLayout={measure} accessibilityLabel="Carte des zones masquées">
      {size === null ? null : <ZonesMap key={`${framing}@${size.width}x${size.height}`} zones={zones} size={size} />}
    </View>
  );
}

function zoneDetail(zone: PrivacyZone): string {
  return `rayon ${formatInteger(zone.radiusMeters)} m · masqué jusqu'à ${formatInteger(effectiveRadiusMeters(zone))} m`;
}

/** The zones in force, each opened in the map editor (`PRV-010`). */
export function PrivacyZonesScreen() {
  const zones = usePrivacyZones();
  return (
    <View style={styles.root}>
      <Screen bottomInset={120}>
        <AppBar title="Zones de confidentialité" variant="context" leading={<BackButton />} />
        <Text tone="secondary" style={styles.intro}>
          Autour de ces lieux, la trace est retirée des exports, des aperçus et des réponses de l'agent. Distance, temps et dénivelé restent ceux de la sortie entière.
        </Text>
        {zones.length === 0 ? null : <ZonesOverview zones={zones} />}
        <Section title="Zones">
          {zones.length === 0 ? (
            <Text tone="tertiary" style={styles.empty}>
              Aucune zone : ajoute ton domicile ou ton travail
            </Text>
          ) : (
            zones.map((zone, index) => (
              <Row
                key={zone.id}
                title={zone.label}
                detail={zoneDetail(zone)}
                trailing={<Chevron />}
                onPress={() => router.push({ pathname: "/settings/privacy-zone", params: { id: zone.id } })}
                last={index === zones.length - 1}
              />
            ))
          )}
        </Section>
      </Screen>

      <BottomPanel>
        <PrimaryButton label="Ajouter une zone" onPress={() => router.push("/settings/privacy-zone")} />
      </BottomPanel>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  intro: { marginTop: 4 },
  frame: { height: 220, marginTop: 20, borderRadius: radii.panel, borderWidth: 1, overflow: "hidden" },
  attribution: { position: "absolute", right: 8, bottom: 8 },
  empty: { paddingVertical: 16 },
});
