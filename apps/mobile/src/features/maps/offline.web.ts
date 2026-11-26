import type { EpochMs } from "@obnixe/schema";
import type { OfflineRegion, OfflineRegionRequest } from "@/features/maps/offlineRegions";

/** Offline regions live in MapLibre Native's database; the browser only keeps its own HTTP cache. */
export const offlineMapsAvailable = false;

const none: readonly OfflineRegion[] = [];

export function useOfflineRegions(): readonly OfflineRegion[] {
  return none;
}

export class OfflineMapsUnavailableError extends Error {
  constructor() {
    super("Offline map regions are only available on the phone");
  }
}

export function downloadOfflineRegion(_request: OfflineRegionRequest, _now: EpochMs): Promise<void> {
  return Promise.reject(new OfflineMapsUnavailableError());
}

export function updateOfflineRegion(_id: string): Promise<void> {
  return Promise.reject(new OfflineMapsUnavailableError());
}

export function deleteOfflineRegion(_id: string): Promise<void> {
  return Promise.reject(new OfflineMapsUnavailableError());
}
