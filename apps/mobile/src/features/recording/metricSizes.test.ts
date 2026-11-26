import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fitBounds, metricSizes } from "@/features/recording/metricSizes";

const source = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("live metric sizes (UX-001)", () => {
  it("keeps the main metric at 64 pt and the others at 32 pt once shrunk to fit", () => {
    expect(metricSizes.main.minimum).toBeGreaterThanOrEqual(64);
    expect(metricSizes.guided.minimum).toBeGreaterThanOrEqual(64);
    for (const metric of Object.values(metricSizes)) {
      expect(metric.minimum).toBeGreaterThanOrEqual(32);
      expect(metric.minimum).toBeLessThanOrEqual(metric.size);
    }
  });

  it("bounds the shrink on both platforms: a scale for iOS, pixels for Android", () => {
    expect(fitBounds(metricSizes.compact, 2.625)).toEqual({ minimumFontScale: 0.8, minimumFontSize: 84 });
    expect(fitBounds(metricSizes.main, 3).minimumFontSize).toBe(198);
  });

  it("sizes every live tile from the table", () => {
    for (const file of ["LiveScreen.tsx", "ElevationPage.tsx", "GuidedPanel.tsx", "LiveParts.tsx"]) {
      expect(source(file)).not.toMatch(/minimumScale|<MetricTile[^>]*\ssize=/);
    }
    expect(source("LiveParts.tsx")).toMatch(/minimumFontScale=\{minimumFontScale\}\s+\{\.\.\.\{ minimumFontSize \}\}/);
  });
});
