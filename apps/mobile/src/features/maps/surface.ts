import type { Ref } from "react";
import type { LayerSpecification, StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { Bounds } from "@/features/maps/tiles";

/** A GeoJSON source drawn over the base style, with its layers; `data` is GeoJSON text. */
export interface MapOverlay {
  readonly id: string;
  readonly data: string;
  readonly lineMetrics: boolean;
  readonly layers: readonly LayerSpecification[];
  /** A base style layer the overlay is drawn under; on top of the base when absent. */
  readonly beforeId?: string;
}

/** Contour lines the map draws from DEM tiles from z12 (`MAP-006`). */
export interface MapContours {
  readonly layers: readonly LayerSpecification[];
  readonly beforeId: string;
}

export type LngLat = readonly [number, number];

export interface MapCamera {
  readonly center: LngLat;
  readonly zoom: number;
}

export interface MapCameraMove {
  readonly center: LngLat;
  readonly zoom?: number;
  readonly bearing?: number;
  readonly durationMs: number;
}

export interface MapView {
  readonly center: LngLat;
  readonly bounds: Bounds;
  readonly zoom: number;
}

export interface MapSurfaceHandle {
  readonly moveTo: (move: MapCameraMove) => void;
}

export interface MapSurfaceProps {
  readonly mapStyle: StyleSpecification | string;
  /** Drawn when `mapStyle` cannot load (remote style, no network, no cache) so overlays stay visible (MAP-032). */
  readonly fallbackStyle: StyleSpecification;
  readonly initialCamera: MapCamera;
  readonly overlays?: readonly MapOverlay[];
  readonly contours?: MapContours | null;
  readonly interactive?: boolean;
  readonly onUserGesture?: () => void;
  /** Every frame of a camera move, for overlays drawn in screen space. */
  readonly onViewChanging?: (view: MapView) => void;
  readonly onViewChanged?: (view: MapView) => void;
  /** A tap on the map, outside any gesture. */
  readonly onPress?: (point: LngLat) => void;
  readonly ref?: Ref<MapSurfaceHandle>;
}
