import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { AppState, StyleSheet, View } from "react-native";
import type { RouteRejoin } from "@obnixe/core";
import type { SportKey } from "@obnixe/schema";
import type { PreviewPath } from "@/features/activityFiles/importActivity";
import { follow, followResumeDelayMs, initialFollow } from "@/features/maps/follow";
import type { LiveMapFeed } from "@/features/maps/liveTrack";
import { AttributionButton, MapButton } from "@/features/maps/MapControls";
import { MapSurface } from "@/features/maps/MapSurface";
import { outdoorPalettes } from "@/features/maps/outdoorStyle";
import { rejoinData, rejoinLayers, rejoinSourceId, routeLayers, routeLineData, routeSourceId } from "@/features/maps/routeLayers";
import type { MapOverlay, MapSurfaceHandle } from "@/features/maps/surface";
import { pointLayers, pointsSourceId, trackLayers, trackSourceId } from "@/features/maps/trackLayers";
import { useMapBase } from "@/features/maps/useMapBase";
import { useTheme } from "@/ui/theme";
import { layout } from "@/ui/tokens";

type Orientation = "north" | "course";

const followZoom = 15.5;
const followMoveMs = 900;
const recenterMoveMs = 450;
const franceOverview = { center: [2.4, 46.6] as const, zoom: 5 };

function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => subscription.remove();
  }, []);
  return active;
}

interface LiveMapProps {
  readonly feed: LiveMapFeed;
  readonly sport: SportKey;
  /** `RTE-003`: the followed route, drawn under the track. */
  readonly route: PreviewPath | null;
  /** `RTE-005`: off the route, where to join it again. */
  readonly rejoin: RouteRejoin | null;
  /** False while another page of the live screen is shown. */
  readonly visible: boolean;
}

/** Live recording map (MAP-010..MAP-012): unmounted, so neither drawn nor fed, while hidden or in the background. */
export function LiveMap({ feed, sport, route, rejoin, visible }: LiveMapProps) {
  const { name } = useTheme();
  const appActive = useAppActive();
  if (!visible || !appActive) return <View style={[StyleSheet.absoluteFill, { backgroundColor: outdoorPalettes[name].land }]} />;
  return <LiveMapView feed={feed} sport={sport} route={route} rejoin={rejoin} />;
}

type LiveMapViewProps = Omit<LiveMapProps, "visible">;

function LiveMapView({ feed, sport, route, rejoin }: LiveMapViewProps) {
  const { name, colors } = useTheme();
  const base = useMapBase(sport);
  const frame = useSyncExternalStore(feed.subscribe, feed.frame);
  const [followState, dispatch] = useReducer(follow, initialFollow);
  const [orientation, setOrientation] = useState<Orientation>("north");
  const surface = useRef<MapSurfaceHandle>(null);
  const zoomed = useRef(false);
  const [initialCamera] = useState(() => (frame.position === null ? franceOverview : { center: [frame.position.longitude, frame.position.latitude] as const, zoom: followZoom }));

  const trackColors = useMemo(() => ({ from: colors.sportDeep[sport], to: colors.sport[sport] }), [colors, sport]);
  const layers = useMemo(
    () => ({ track: trackLayers(trackColors, name), points: pointLayers(trackColors, name), route: routeLayers(colors.mark, name), rejoin: rejoinLayers(colors.mark, name) }),
    [trackColors, colors.mark, name],
  );
  const routeLine = useMemo(() => (route === null ? null : routeLineData(route.coordinates)), [route]);
  const position = frame.position;
  const rejoinLine = rejoin === null || position === null ? null : rejoinData([position.longitude, position.latitude], [rejoin.longitude, rejoin.latitude]);
  const overlays = useMemo<MapOverlay[]>(
    () => [
      ...(routeLine === null
        ? []
        : [
            { id: routeSourceId, data: routeLine, lineMetrics: false, layers: layers.route },
            { id: rejoinSourceId, data: rejoinLine ?? rejoinData(null, null), lineMetrics: false, layers: layers.rejoin },
          ]),
      { id: trackSourceId, data: frame.track, lineMetrics: true, layers: layers.track },
      { id: pointsSourceId, data: frame.points, lineMetrics: false, layers: layers.points },
    ],
    [routeLine, rejoinLine, frame.track, frame.points, layers],
  );

  const following = followState.following;
  useEffect(() => {
    if (!following || position === null) return;
    const bearing = orientation === "north" ? 0 : (position.bearingDegrees ?? undefined);
    surface.current?.moveTo({
      center: [position.longitude, position.latitude],
      ...(zoomed.current ? {} : { zoom: followZoom }),
      ...(bearing === undefined ? {} : { bearing }),
      durationMs: zoomed.current ? followMoveMs : recenterMoveMs,
    });
    zoomed.current = true;
  }, [following, position, orientation]);

  const lastGestureAt = followState.lastGestureAt;
  useEffect(() => {
    if (following || lastGestureAt === null) return;
    const timer = setTimeout(() => dispatch({ type: "tick", at: Date.now() }), followResumeDelayMs - (Date.now() - lastGestureAt));
    return () => clearTimeout(timer);
  }, [following, lastGestureAt]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapSurface
        ref={surface}
        mapStyle={base.style}
        fallbackStyle={base.fallback}
        initialCamera={initialCamera}
        overlays={overlays}
        contours={base.contours}
        onUserGesture={() => dispatch({ type: "gesture", at: Date.now() })}
      />
      <View style={styles.controls} pointerEvents="box-none">
        <MapButton
          icon="north"
          label={orientation === "north" ? "Orienter selon la direction" : "Orienter vers le nord"}
          active={orientation === "course"}
          onPress={() => setOrientation((current) => (current === "north" ? "course" : "north"))}
        />
        {following ? null : <MapButton icon="locate" label="Recentrer" onPress={() => dispatch({ type: "recenter" })} />}
      </View>
      <View style={styles.attribution} pointerEvents="box-none">
        <AttributionButton attribution={base.attribution} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  controls: { position: "absolute", right: layout.gutter, bottom: layout.gutter, gap: 12, alignItems: "center" },
  attribution: { position: "absolute", left: layout.gutter, bottom: layout.gutter },
});
