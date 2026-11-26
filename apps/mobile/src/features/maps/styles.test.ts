import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { MapEmphasis } from "@/features/maps/outdoorStyle";
import { blankStyle, emphasisOf, outdoorStyle, resolveMapBase } from "@/features/maps/styles";
import type { PaletteName } from "@/ui/tokens";

const assets = fileURLToPath(new URL("../../../public/maps/", import.meta.url));
const variants: readonly PaletteName[] = ["dark", "sunlight"];
const emphases: readonly MapEmphasis[] = ["foot", "bike"];

function collect(value: unknown, key: string, found: unknown[]): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, key, found);
  } else if (typeof value === "object" && value !== null) {
    for (const [name, child] of Object.entries(value)) {
      if (name === key) found.push(child);
      collect(child, key, found);
    }
  }
  return found;
}

function fontStacks(style: StyleSpecification): Set<string> {
  const stacks = new Set<string>();
  for (const value of collect(style.layers, "text-font", [])) {
    const fonts = Array.isArray(value) && value[0] === "literal" ? value[1] : value;
    if (Array.isArray(fonts)) for (const font of fonts) stacks.add(String(font));
  }
  return stacks;
}

function iconNames(style: StyleSpecification): Set<string> {
  const names = new Set<string>();
  for (const value of collect(style.layers, "icon-image", [])) {
    if (typeof value === "string") names.add(value);
    else if (Array.isArray(value)) for (const item of value.slice(1)) if (typeof item === "string") names.add(item);
  }
  return names;
}

describe("Obnixe Outdoor", () => {
  it.each(variants.flatMap((variant) => emphases.map((emphasis) => [variant, emphasis] as const)))("is a valid MapLibre style in %s for %s", (variant, emphasis) => {
    expect(validateStyleMin(outdoorStyle(variant, emphasis))).toEqual([]);
  });

  it("only draws with the embedded fonts and sprite icons", () => {
    const style = outdoorStyle("dark", "foot");
    const sprite = JSON.parse(readFileSync(`${assets}sprites/obnixe.json`, "utf8")) as Record<string, { readonly sdf?: boolean }>;
    for (const stack of fontStacks(style)) expect(existsSync(`${assets}glyphs/${stack}/0-255.pbf`), stack).toBe(true);
    for (const icon of iconNames(style)) expect(sprite[icon]?.sdf, icon).toBe(true);
    expect(existsSync(`${assets}overlay/heading.png`)).toBe(true);
  });

  it("names only free providers and the bundled assets", () => {
    const urls = JSON.stringify(outdoorStyle("sunlight", "bike")).match(/[a-z]+:\/\/[^"]+/g) ?? [];
    for (const url of urls) expect(url).toMatch(/^(asset:\/\/maps\/|https:\/\/tiles\.openfreemap\.org\/|https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\/)/);
  });

  it("keeps the same sources in every variant so offline tiles serve both themes", () => {
    expect(outdoorStyle("dark", "foot").sources).toEqual(outdoorStyle("sunlight", "bike").sources);
  });

  it("brings cycleways forward for cycling only", () => {
    const cycleway = (emphasis: MapEmphasis) => outdoorStyle("dark", emphasis).layers.find((layer) => layer.id === "trail-cycleway");
    expect(collect(cycleway("foot"), "line-dasharray", [])).not.toEqual([]);
    expect(collect(cycleway("bike"), "line-dasharray", [])).toEqual([]);
  });
});

describe("map bases", () => {
  it("emphasizes cycleways for cycling only", () => {
    expect(emphasisOf("bike")).toBe("bike");
    expect(emphasisOf("hike")).toBe("foot");
    expect(emphasisOf(null)).toBe("foot");
  });

  it("credits every source and downloads relief up to z12", () => {
    const outdoor = resolveMapBase({ mapStyle: "obnixe_outdoor", variant: "dark", emphasis: "foot" });
    expect(outdoor.attribution.map((source) => source.label)).toEqual([
      "© OpenFreeMap",
      "© OpenMapTiles",
      "© OpenStreetMap contributors",
      "Relief : Terrain Tiles, AWS Open Data",
    ]);
    expect(outdoor.offline).toEqual({ vector: { min: 5, max: 14 }, relief: { min: 5, max: 12 } });
  });

  it("loads Plan IGN from the official style", () => {
    const ign = resolveMapBase({ mapStyle: "plan_ign", variant: "sunlight", emphasis: "bike" });
    expect(ign.style).toBe("https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/standard.json");
    expect(ign.attribution.map((source) => source.label)).toEqual(["© IGN"]);
    expect(ign.offline.relief).toBeNull();
  });

  it("falls back to a plain valid ground", () => {
    for (const variant of variants) expect(validateStyleMin(blankStyle(variant))).toEqual([]);
  });
});
