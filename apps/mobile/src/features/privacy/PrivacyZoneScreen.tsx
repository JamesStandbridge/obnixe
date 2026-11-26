import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { getRandomValues } from "expo-crypto";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { asc, isNull } from "drizzle-orm";
import { drawMaskScalePermille, editPrivacyZone, effectiveRadiusMeters, newPrivacyZone, privacyZoneProblem, privacyZoneRadiusBounds, trashMutation } from "@obnixe/core";
import type { GeoPoint, PrivacyZoneDraft } from "@obnixe/core";
import { privacyZone } from "@obnixe/schema";
import type { PrivacyZone } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { useUndoableWrite, write } from "@/data/write";
import { AttributionButton, MapButton } from "@/features/maps/MapControls";
import { MapSurface } from "@/features/maps/MapSurface";
import type { MapCamera, MapOverlay, MapView } from "@/features/maps/surface";
import { useMapBase } from "@/features/maps/useMapBase";
import { fitCamera } from "@/features/maps/viewport";
import type { ViewSize } from "@/features/maps/viewport";
import { usePrivacyZones } from "@/features/privacy/usePrivacyZones";
import { minPlacementPixels, privacyZoneLayers, privacyZonesSourceId, radiusPixels, zoneCenter, zonesBounds, zonesGeoJson } from "@/features/privacy/zoneShapes";
import { formatInteger } from "@/format/numbers";
import { LinkButton, PrimaryButton } from "@/ui/Button";
import { Stepper } from "@/ui/Controls";
import { TextField } from "@/ui/Inputs";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { layout } from "@/ui/tokens";

const franceOverview: MapCamera = { center: [2.4, 46.6], zoom: 5.4 };
const nearZoneZoom = 13;
const zonePadding = 48;
const zoneMaxZoom = 16;
const defaultRadiusMeters = 300;
const radiusStep = 50;

/** The draw protects the center against triangulation, so it comes from the secure generator. */
function drawMask(): number {
  return drawMaskScalePermille(() => new DataView(getRandomValues(new Uint8Array(4)).buffer).getUint32(0) / 2 ** 32);
}

function lngLat(point: GeoPoint): MapCamera["center"] {
  return [point.longitude, point.latitude];
}

function openingCamera(zone: PrivacyZone | null, latest: PrivacyZone | null, size: ViewSize): MapCamera {
  if (zone !== null) {
    const bounds = zonesBounds([zone]);
    return { center: lngLat(zoneCenter(zone)), zoom: bounds === null ? nearZoneZoom : fitCamera(bounds, size, zonePadding, zoneMaxZoom).zoom };
  }
  if (latest !== null) return { center: lngLat(zoneCenter(latest)), zoom: nearZoneZoom };
  return franceOverview;
}

interface ZoneTargetProps {
  readonly size: ViewSize;
  readonly view: MapCamera;
  readonly radiusMeters: number;
  readonly maskedMeters: number;
}

/** The zone being placed, drawn in screen space at the center of the map so it follows every frame of a gesture. */
function ZoneTarget({ size, view, radiusMeters, maskedMeters }: ZoneTargetProps) {
  const { colors } = useTheme();
  const latitude = view.center[1];
  const x = size.width / 2;
  const y = size.height / 2;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width={size.width} height={size.height}>
        <Circle cx={x} cy={y} r={radiusPixels(maskedMeters, latitude, view.zoom)} fill={colors.mark} fillOpacity={0.18} stroke={colors.mark} strokeWidth={1.5} strokeDasharray="6 4" />
        <Circle cx={x} cy={y} r={radiusPixels(radiusMeters, latitude, view.zoom)} fill="none" stroke={colors.mark} strokeWidth={2.5} />
        <Circle cx={x} cy={y} r={5} fill={colors.mark} stroke={colors.bg} strokeWidth={2} />
      </Svg>
    </View>
  );
}

interface ZonePickerProps {
  readonly camera: MapCamera;
  readonly size: ViewSize;
  readonly others: readonly PrivacyZone[];
  readonly radiusMeters: number;
  readonly maskedMeters: number;
  /** The settled view after the user moved the map: its center is the zone's center. */
  readonly onPlaced: (view: MapView) => void;
}

function ZonePicker({ camera, size, others, radiusMeters, maskedMeters, onPlaced }: ZonePickerProps) {
  const { colors } = useTheme();
  const base = useMapBase(null);
  const [live, setLive] = useState<MapCamera>(camera);
  const gestured = useRef(false);
  const overlays = useMemo<MapOverlay[]>(() => [{ id: privacyZonesSourceId, data: zonesGeoJson(others), lineMetrics: false, layers: privacyZoneLayers(colors.text2) }], [others, colors.text2]);
  const settle = useCallback(
    (view: MapView) => {
      setLive(view);
      if (gestured.current) onPlaced(view);
    },
    [onPlaced],
  );
  const map = useMemo(
    () => (
      <MapSurface
        mapStyle={base.style}
        fallbackStyle={base.fallback}
        initialCamera={camera}
        overlays={overlays}
        onUserGesture={() => {
          gestured.current = true;
        }}
        onViewChanging={setLive}
        onViewChanged={settle}
      />
    ),
    [base, camera, overlays, settle],
  );
  return (
    <>
      {map}
      <ZoneTarget size={size} view={live} radiusMeters={radiusMeters} maskedMeters={maskedMeters} />
      <View style={styles.attribution}>
        <AttributionButton attribution={base.attribution} />
      </View>
    </>
  );
}

interface ZoneEditorProps {
  readonly zone: PrivacyZone | null;
  readonly latest: PrivacyZone | null;
}

function ZoneEditor({ zone, latest }: ZoneEditorProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const zones = usePrivacyZones();
  const undoable = useUndoableWrite();
  const [label, setLabel] = useState(zone?.label ?? "");
  const [radiusMeters, setRadiusMeters] = useState(zone?.radiusMeters ?? defaultRadiusMeters);
  const [maskScalePermille] = useState(() => zone?.maskScalePermille ?? drawMask());
  const [size, setSize] = useState<ViewSize | null>(null);
  const [camera, setCamera] = useState<MapCamera | null>(null);
  const [placed, setPlaced] = useState<MapView | null>(null);
  const others = useMemo(() => zones.filter((other) => other.id !== zone?.id), [zones, zone]);

  const measure = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) => (current?.width === width && current.height === height ? current : { width, height }));
    setCamera((current) => current ?? openingCamera(zone, latest, { width, height }));
  };

  const maskedMeters = effectiveRadiusMeters({ radiusMeters, maskScalePermille });
  const view = placed ?? camera;
  const center: GeoPoint | null = placed !== null ? { latitude: placed.center[1], longitude: placed.center[0] } : zone !== null ? zoneCenter(zone) : null;
  const precise = view !== null && radiusPixels(radiusMeters, view.center[1], view.zoom) >= minPlacementPixels;
  const draft: PrivacyZoneDraft | null = center === null ? null : { label, center, radiusMeters };
  const ready = draft !== null && precise && privacyZoneProblem(draft) === null;

  const leave = (): void => (router.canGoBack() ? router.back() : router.replace("/settings/privacy-zones"));

  const save = (): void => {
    if (draft === null) return;
    if (zone === null) {
      write(`Zone de confidentialité : ${draft.label.trim()}`, [newPrivacyZone(environment, draft, maskScalePermille).mutation]);
    } else {
      const edit = editPrivacyZone(zone, draft);
      if (edit !== null) write(`Zone de confidentialité modifiée : ${draft.label.trim()}`, [edit]);
    }
    leave();
  };

  const remove = (target: PrivacyZone): void => {
    undoable({ summary: `Zone de confidentialité supprimée : ${target.label}`, mutations: [trashMutation("privacy_zone", target.id, environment.now())], message: `Zone « ${target.label} » supprimée` });
    leave();
  };

  const caption = !precise
    ? "Rapproche-toi pour placer le centre sur le lieu à masquer"
    : center === null
      ? "Déplace la carte pour placer le centre sur le lieu à masquer"
      : `Rien n'est montré à moins de ${formatInteger(maskedMeters)} m du centre, ni le long de la trace autour de chaque passage`;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={styles.map} onLayout={measure}>
        {size === null || camera === null ? null : <ZonePicker camera={camera} size={size} others={others} radiusMeters={radiusMeters} maskedMeters={maskedMeters} onPlaced={setPlaced} />}
        <View style={[styles.back, { top: insets.top + 8 }]}>
          <MapButton icon="back" label="Retour" onPress={leave} />
        </View>
      </View>
      <View style={[styles.panel, { borderTopColor: colors.line, paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.head}>
          <Text variant="heading" style={styles.title}>
            {zone === null ? "Nouvelle zone" : "Modifier la zone"}
          </Text>
          {zone === null ? null : <LinkButton label="Supprimer" onPress={() => remove(zone)} />}
        </View>
        <TextField value={label} onChangeText={setLabel} placeholder="Nom du lieu : maison, travail…" accessibilityLabel="Nom de la zone" maxLength={40} />
        <Stepper
          value={radiusMeters}
          step={radiusStep}
          min={privacyZoneRadiusBounds.minMeters}
          max={privacyZoneRadiusBounds.maxMeters}
          unit="m"
          label="Rayon"
          format={formatInteger}
          onChange={setRadiusMeters}
        />
        <Text variant="small" tone="secondary" accessibilityLiveRegion="polite">
          {caption}
        </Text>
        <PrimaryButton label={zone === null ? "Créer la zone" : "Enregistrer"} disabled={!ready} onPress={save} />
      </View>
    </View>
  );
}

/** Places a privacy zone on the map with its label and radius, previewing the area it masks (`PRV-010`, `PRV-012`). */
export function PrivacyZoneScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const [opened] = useState(() => {
    const zones = db().select().from(privacyZone).where(isNull(privacyZone.deletedAt)).orderBy(asc(privacyZone.createdAt)).all();
    return { zone: zones.find((zone) => zone.id === id) ?? null, latest: zones[zones.length - 1] ?? null };
  });
  if (id !== undefined && opened.zone === null) return <Redirect href="/settings/privacy-zones" />;
  return <ZoneEditor zone={opened.zone} latest={opened.latest} />;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  map: { flex: 1, overflow: "hidden" },
  back: { position: "absolute", left: layout.gutter },
  attribution: { position: "absolute", right: 8, bottom: 8 },
  panel: { borderTopWidth: 1, paddingTop: 16, paddingHorizontal: layout.gutter, gap: 12 },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: { flex: 1 },
});
