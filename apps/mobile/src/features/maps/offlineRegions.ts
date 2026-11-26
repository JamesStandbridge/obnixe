import type { EpochMs, MapStyle } from "@obnixe/schema";
import type { Bounds } from "@/features/maps/tiles";

export type OfflineRegionState = "downloading" | "paused" | "complete";

export interface OfflineRegion {
  readonly id: string;
  readonly name: string;
  readonly createdAt: EpochMs;
  readonly mapStyle: MapStyle;
  readonly bounds: Bounds;
  readonly state: OfflineRegionState;
  readonly percentage: number;
  readonly bytes: number;
}

export interface OfflineRegionRequest {
  readonly name: string;
  readonly bounds: Bounds;
  readonly mapStyle: MapStyle;
}

export interface StoredPack {
  readonly id: string;
  readonly bounds: Bounds;
  readonly name: string;
  readonly createdAt: number;
  readonly mapStyle: MapStyle;
}

export interface PackProgress {
  readonly state: "inactive" | "active" | "complete";
  readonly percentage: number;
  readonly completedResourceSize: number;
}

export function regionFromPack(pack: StoredPack, progress: PackProgress): OfflineRegion {
  return {
    id: pack.id,
    name: pack.name,
    createdAt: pack.createdAt as EpochMs,
    mapStyle: pack.mapStyle,
    bounds: pack.bounds,
    state: progress.state === "complete" ? "complete" : progress.state === "active" ? "downloading" : "paused",
    percentage: Math.max(0, Math.min(100, progress.percentage)),
    bytes: progress.completedResourceSize,
  };
}

export function offlineBytes(regions: readonly OfflineRegion[]): number {
  return regions.reduce((total, region) => total + region.bytes, 0);
}
