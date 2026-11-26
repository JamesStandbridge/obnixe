import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { AddLayerObject, GeoJSONSource, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { mapAssetsUrl } from "@/features/maps/assets";
import type { MapOverlay, MapSurfaceProps, MapView } from "@/features/maps/surface";
import { headingImage } from "@/features/maps/trackLayers";
import { useContours } from "@/features/maps/useContours";

const headingUrl = `${mapAssetsUrl}/overlay/heading@2x.png`;

interface AppliedOverlay {
  readonly data: string;
  readonly layers: string;
}

function syncOverlays(map: maplibregl.Map, overlays: readonly MapOverlay[], applied: Map<string, AppliedOverlay>): void {
  const wanted = new Set(overlays.map((overlay) => overlay.id));
  for (const [id, previous] of applied) {
    if (wanted.has(id)) continue;
    for (const layer of JSON.parse(previous.layers) as AddLayerObject[]) if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    if (map.getSource(id)) map.removeSource(id);
    applied.delete(id);
  }
  overlays.forEach((overlay, position) => {
    const previous = applied.get(overlay.id);
    const layers = JSON.stringify(overlay.layers);
    const source = map.getSource<GeoJSONSource>(overlay.id);
    if (source === undefined) map.addSource(overlay.id, { type: "geojson", data: JSON.parse(overlay.data), lineMetrics: overlay.lineMetrics });
    else if (previous?.data !== overlay.data) source.setData(JSON.parse(overlay.data));
    if (previous?.layers !== layers) {
      const before =
        overlay.beforeId !== undefined && map.getLayer(overlay.beforeId) !== undefined
          ? overlay.beforeId
          : overlays
              .slice(position + 1)
              .flatMap((later) => later.layers)
              .find((layer) => map.getLayer(layer.id) !== undefined)?.id;
      for (const layer of overlay.layers) {
        if (map.getLayer(layer.id)) map.removeLayer(layer.id);
        map.addLayer(layer as AddLayerObject, before);
      }
    }
    applied.set(overlay.id, { data: overlay.data, layers });
  });
}

function viewOf(map: maplibregl.Map): MapView {
  const bounds = map.getBounds();
  const center = map.getCenter();
  return { center: [center.lng, center.lat], bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], zoom: map.getZoom() };
}

export function MapSurface({
  mapStyle,
  fallbackStyle,
  initialCamera,
  overlays = [],
  contours = null,
  interactive = true,
  onUserGesture,
  onViewChanging,
  onViewChanged,
  onPress,
  ref,
}: MapSurfaceProps) {
  const container = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<MapView | null>(null);
  const contourOverlay = useContours(contours, view);
  const drawn = useMemo(() => (contourOverlay === null ? overlays : [contourOverlay, ...overlays]), [contourOverlay, overlays]);
  const map = useRef<maplibregl.Map | null>(null);
  const applied = useRef(new Map<string, AppliedOverlay>());
  const styleReady = useRef(false);
  const shownStyle = useRef(mapStyle);
  const latest = useRef({ overlays: drawn, onUserGesture, onViewChanging, onViewChanged, onPress, fallbackStyle, contours });
  latest.current = { overlays: drawn, onUserGesture, onViewChanging, onViewChanged, onPress, fallbackStyle, contours };

  useImperativeHandle(ref, () => ({
    moveTo: ({ center, zoom, bearing, durationMs }) =>
      map.current?.easeTo({ center: [center[0], center[1]], ...(zoom === undefined ? {} : { zoom }), ...(bearing === undefined ? {} : { bearing }), duration: durationMs, easing: (t) => t }),
  }));

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const instance = new maplibregl.Map({
      container: element,
      style: mapStyle as StyleSpecification | string,
      center: [initialCamera.center[0], initialCamera.center[1]],
      zoom: initialCamera.zoom,
      attributionControl: false,
      interactive,
      pitchWithRotate: false,
      dragRotate: interactive,
    });
    map.current = instance;
    instance.on("style.load", () => {
      styleReady.current = true;
      applied.current.clear();
      void instance.loadImage(headingUrl).then(({ data }) => {
        if (!instance.hasImage(headingImage)) instance.addImage(headingImage, data, { sdf: true, pixelRatio: 2 });
      });
      syncOverlays(instance, latest.current.overlays, applied.current);
    });
    instance.on("error", (event) => {
      if (styleReady.current || "sourceId" in event || shownStyle.current === latest.current.fallbackStyle) return;
      shownStyle.current = latest.current.fallbackStyle;
      instance.setStyle(latest.current.fallbackStyle as StyleSpecification, { diff: false });
    });
    const gesture = (event: { originalEvent?: unknown }): void => {
      if (event.originalEvent !== undefined) latest.current.onUserGesture?.();
    };
    instance.on("dragstart", gesture);
    instance.on("zoomstart", gesture);
    instance.on("rotatestart", gesture);
    const viewChanged = (): void => {
      const changed = viewOf(instance);
      if (latest.current.contours !== null) setView(changed);
      latest.current.onViewChanged?.(changed);
    };
    instance.once("load", viewChanged);
    instance.on("move", () => latest.current.onViewChanging?.(viewOf(instance)));
    instance.on("moveend", viewChanged);
    instance.on("click", (event) => latest.current.onPress?.([event.lngLat.lng, event.lngLat.lat]));
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (instance === null || shownStyle.current === mapStyle) return;
    shownStyle.current = mapStyle;
    styleReady.current = false;
    instance.setStyle(mapStyle as StyleSpecification | string, { diff: false });
  }, [mapStyle]);

  useEffect(() => {
    const instance = map.current;
    if (instance !== null && styleReady.current) syncOverlays(instance, drawn, applied.current);
  }, [drawn]);

  return <div ref={container} style={{ position: "absolute", inset: 0 }} />;
}
