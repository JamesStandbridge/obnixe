import { describe, expect, it } from "vitest";
import { offlineBytes, regionFromPack } from "@/features/maps/offlineRegions";
import type { StoredPack } from "@/features/maps/offlineRegions";

const pack: StoredPack = { id: "a", bounds: [6.7, 45.8, 7.1, 46.1], name: "Chamonix", createdAt: 1_700_000_000_000, mapStyle: "obnixe_outdoor" };

describe("offline regions", () => {
  it("maps the pack states", () => {
    expect(regionFromPack(pack, { state: "active", percentage: 42.5, completedResourceSize: 10 }).state).toBe("downloading");
    expect(regionFromPack(pack, { state: "inactive", percentage: 42.5, completedResourceSize: 10 }).state).toBe("paused");
    expect(regionFromPack(pack, { state: "complete", percentage: 100, completedResourceSize: 10 }).state).toBe("complete");
  });

  it("clamps the progress and sums the space used", () => {
    const first = regionFromPack(pack, { state: "active", percentage: 104, completedResourceSize: 1_500_000 });
    const second = regionFromPack({ ...pack, id: "b" }, { state: "complete", percentage: 100, completedResourceSize: 2_500_000 });
    expect(first.percentage).toBe(100);
    expect(offlineBytes([first, second])).toBe(4_000_000);
  });
});
