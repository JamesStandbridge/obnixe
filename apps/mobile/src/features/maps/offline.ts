import { useEffect, useSyncExternalStore } from "react";
import { OfflineManager } from "@maplibre/maplibre-react-native";
import type { OfflinePack, OfflinePackStatus } from "@maplibre/maplibre-react-native";
import { Directory, File, Paths } from "expo-file-system";
import { z } from "zod";
import { mapStyles } from "@obnixe/schema";
import type { EpochMs, MapStyle } from "@obnixe/schema";
import { regionFromPack } from "@/features/maps/offlineRegions";
import type { OfflineRegion, OfflineRegionRequest } from "@/features/maps/offlineRegions";
import { resolveMapBase } from "@/features/maps/styles";

export const offlineMapsAvailable = true;

const metadataSchema = z.object({ name: z.string(), createdAt: z.number(), mapStyle: z.enum(mapStyles) });

type Listener = () => void;

class OfflineRegionStore {
  private regions: readonly OfflineRegion[] = [];
  private readonly listeners = new Set<Listener>();
  private loading: Promise<void> | null = null;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly snapshot = (): readonly OfflineRegion[] => this.regions;

  /** Reads the stored packs once and resumes the downloads a closed app or a lost network interrupted (MAP-031). */
  load(): Promise<void> {
    this.loading ??= (async () => {
      const packs = await OfflineManager.getPacks();
      for (const pack of packs) {
        const status = await pack.status();
        this.apply(pack, status);
        if (status.state !== "complete") await this.observe(pack, true);
      }
    })();
    return this.loading;
  }

  async download(request: OfflineRegionRequest, now: EpochMs): Promise<void> {
    const base = resolveMapBase({ mapStyle: request.mapStyle, variant: "dark", emphasis: "foot" });
    const pack = await OfflineManager.createPack(
      {
        mapStyle: await packStyleUrl(request.mapStyle),
        bounds: [...request.bounds],
        minZoom: base.offline.base.zoom.min,
        maxZoom: base.offline.base.zoom.max,
        metadata: { name: request.name, createdAt: now, mapStyle: request.mapStyle },
      },
      (target, status) => this.apply(target, status),
      (target) => this.pause(target.id),
    );
    this.apply(pack, await pack.status());
  }

  /** Re-checks every resource of the region against the network and downloads what changed. */
  async update(id: string): Promise<void> {
    await OfflineManager.invalidatePack(id);
    const pack = await OfflineManager.getPack(id);
    await this.observe(pack, true);
  }

  async remove(id: string): Promise<void> {
    OfflineManager.removeListener(id);
    await OfflineManager.deletePack(id);
    this.publish(this.regions.filter((region) => region.id !== id));
  }

  private async observe(pack: OfflinePack, resume: boolean): Promise<void> {
    await OfflineManager.addListener(
      pack.id,
      (target, status) => this.apply(target, status),
      (target) => this.pause(target.id),
    );
    if (resume) await pack.resume();
  }

  private apply(pack: OfflinePack, status: OfflinePackStatus): void {
    const metadata = metadataSchema.safeParse(pack.metadata);
    if (!metadata.success) return;
    const region = regionFromPack({ id: pack.id, bounds: pack.bounds, ...metadata.data }, status);
    const index = this.regions.findIndex((existing) => existing.id === region.id);
    this.publish(index === -1 ? [...this.regions, region] : this.regions.map((existing, at) => (at === index ? region : existing)));
  }

  private pause(id: string): void {
    this.publish(this.regions.map((region) => (region.id === id && region.state === "downloading" ? { ...region, state: "paused" } : region)));
  }

  private publish(regions: readonly OfflineRegion[]): void {
    this.regions = [...regions].sort((a, b) => b.createdAt - a.createdAt);
    for (const listener of this.listeners) listener();
  }
}

/** Offline packs take a style URL: inline styles are written to a file MapLibre reads back. */
async function packStyleUrl(mapStyle: MapStyle): Promise<string> {
  const { style } = resolveMapBase({ mapStyle, variant: "dark", emphasis: "foot" });
  if (typeof style === "string") return style;
  const directory = new Directory(Paths.document, "maps");
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, `${mapStyle}.json`);
  if (file.exists) file.delete();
  file.create();
  await file.write(JSON.stringify(style));
  return file.uri;
}

const store = new OfflineRegionStore();

export function useOfflineRegions(): readonly OfflineRegion[] {
  useEffect(() => {
    void store.load();
  }, []);
  return useSyncExternalStore(store.subscribe, store.snapshot);
}

export async function downloadOfflineRegion(request: OfflineRegionRequest, now: EpochMs): Promise<void> {
  await store.load();
  await store.download(request, now);
}

export function updateOfflineRegion(id: string): Promise<void> {
  return store.update(id);
}

export function deleteOfflineRegion(id: string): Promise<void> {
  return store.remove(id);
}
