import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { MapEmphasis } from "@/features/maps/outdoorStyle";
import { blankStyle, contourSource, demTileUrl, emphasisOf, mapStyleOptions, orthoStyle, outdoorStyle, resolveMapBase } from "@/features/maps/styles";
import { trackLayers } from "@/features/maps/trackLayers";
import type { PaletteName } from "@/ui/tokens";

const assets = fileURLToPath(new URL("../../../public/maps/", import.meta.url));
const variants: readonly PaletteName[] = ["dark", "sunlight"];
const emphases: readonly MapEmphasis[] = ["foot", "bike"];
const sources = fileURLToPath(new URL("../../", import.meta.url));
const providerHosts = /(openfreemap\.org|amazonaws\.com|geopf\.fr|ign\.fr|openstreetmap\.org|maptiler|mapbox|stadiamaps|thunderforest)/;

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

describe("Obnixe Outdoor (MAP-002)", () => {
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

  it("names only free providers and the bundled assets (MAP-003)", () => {
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

  it("credits every source and downloads relief up to z12 (MAP-004)", () => {
    const outdoor = resolveMapBase({ mapStyle: "obnixe_outdoor", variant: "dark", emphasis: "foot" });
    expect(outdoor.attribution.map((source) => source.label)).toEqual([
      "© OpenFreeMap",
      "© OpenMapTiles",
      "© OpenStreetMap contributors",
      "Relief : Terrain Tiles, AWS Open Data",
    ]);
    expect(outdoor.offline).toEqual({ base: { kind: "vector", zoom: { min: 5, max: 14 } }, relief: { min: 5, max: 12 } });
  });

  it("loads Plan IGN from the official style (MAP-007)", () => {
    const ign = resolveMapBase({ mapStyle: "plan_ign", variant: "sunlight", emphasis: "bike" });
    expect(ign.style).toBe("https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/standard.json");
    expect(ign.attribution.map((source) => source.label)).toEqual(["© IGN"]);
    expect(ign.offline.relief).toBeNull();
    expect(ign.contours).toBeNull();
  });

  it("shows BD ORTHO aerial imagery from the Géoplateforme, credited to IGN (MAP-007)", () => {
    const ortho = resolveMapBase({ mapStyle: "ortho_ign", variant: "dark", emphasis: "foot" });
    expect(validateStyleMin(orthoStyle())).toEqual([]);
    expect(ortho.style).toEqual(orthoStyle());
    expect(ortho.attribution.map((source) => source.label)).toEqual(["© IGN"]);
    expect(ortho.offline).toEqual({ base: { kind: "imagery", zoom: { min: 5, max: 16 } }, relief: null });
    expect(ortho.contours).toBeNull();
    const urls = JSON.stringify(orthoStyle()).match(/[a-z]+:\/\/[^"]+/g) ?? [];
    for (const url of urls) expect(url).toMatch(/^(asset:\/\/maps\/|https:\/\/data\.geopf\.fr\/wmts\?.*LAYER=ORTHOIMAGERY\.ORTHOPHOTOS.*TILEMATRIX=\{z\}&TILEROW=\{y\}&TILECOL=\{x\})/);
    expect(mapStyleOptions.map((option) => option.value)).toEqual(["obnixe_outdoor", "plan_ign", "ortho_ign"]);
  });

  it("draws contour lines under the water and roads of Obnixe Outdoor, labelled with the embedded figures (MAP-006)", () => {
    for (const variant of variants) {
      const { contours } = resolveMapBase({ mapStyle: "obnixe_outdoor", variant, emphasis: "foot" });
      if (contours === null) throw new Error("Outdoor has contours");
      const style = outdoorStyle(variant, "foot");
      const anchor = style.layers.findIndex((layer) => layer.id === contours.beforeId);
      expect(anchor).toBeGreaterThan(style.layers.findIndex((layer) => layer.type === "hillshade"));
      expect(anchor).toBeLessThan(style.layers.findIndex((layer) => layer.id === "water"));
      const withContours: StyleSpecification = {
        ...style,
        sources: { ...style.sources, [contourSource]: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
        layers: [...style.layers.slice(0, anchor), ...contours.layers, ...style.layers.slice(anchor)],
      };
      expect(validateStyleMin(withContours)).toEqual([]);
      expect(Math.min(...contours.layers.map((layer) => layer.minzoom ?? 0))).toBe(12);
      for (const stack of fontStacks(withContours)) expect(existsSync(`${assets}glyphs/${stack}/0-255.pbf`), stack).toBe(true);
    }
  });

  it("samples the DEM from the Terrain Tiles of the relief (ELE-003)", () => {
    expect(demTileUrl({ zoom: 13, x: 4226, y: 2927 })).toBe("https://s3.amazonaws.com/elevation-tiles-prod/terrarium/13/4226/2927.png");
  });

  it("falls back to a plain valid ground (MAP-032)", () => {
    for (const variant of variants) expect(validateStyleMin(blankStyle(variant))).toEqual([]);
  });
});

describe("map sources", () => {
  it("names the tile providers in features/maps/styles.ts only, without API keys (MAP-001)", () => {
    const files = readdirSync(sources, { recursive: true, encoding: "utf8" }).filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts"));
    const naming = files.filter((file) => providerHosts.test(readFileSync(`${sources}${file}`, "utf8")));
    expect(naming).toEqual(["features/maps/styles.ts"]);
    expect(readFileSync(`${sources}features/maps/styles.ts`, "utf8")).not.toMatch(/(api_?key|access_token|key=)/i);
  });

  it("never loads tile.openstreetmap.org (MAP-003)", () => {
    for (const variant of variants) expect(JSON.stringify(outdoorStyle(variant, "foot"))).not.toContain("tile.openstreetmap.org");
  });

  it("shades the relief from terrarium elevation tiles from z9 to z16, softer in the dark theme (MAP-005)", () => {
    for (const variant of variants) {
      const style = outdoorStyle(variant, "foot");
      const relief = style.layers.find((layer) => layer.type === "hillshade");
      expect(relief?.minzoom).toBeLessThanOrEqual(9);
      expect(relief?.maxzoom).toBeGreaterThanOrEqual(16);
      const source = relief === undefined || !("source" in relief) ? undefined : style.sources[relief.source];
      expect(source).toMatchObject({ type: "raster-dem", encoding: "terrarium" });
    }
    const exaggeration = (variant: PaletteName): unknown => {
      const relief = outdoorStyle(variant, "foot").layers.find((layer) => layer.type === "hillshade");
      return relief?.type === "hillshade" ? relief.paint?.["hillshade-exaggeration"] : undefined;
    };
    const stops = (ramp: unknown): number[] => (Array.isArray(ramp) ? ramp.slice(3).filter((_, index) => index % 2 === 1) : []);
    const dark = stops(exaggeration("dark"));
    const sunlight = stops(exaggeration("sunlight"));
    expect(dark).toHaveLength(3);
    dark.forEach((value, index) => expect(value).toBeLessThan((sunlight[index] ?? 0) * 0.8));
    const darkRelief = outdoorStyle("dark", "foot").layers.find((layer) => layer.type === "hillshade");
    expect(JSON.stringify(darkRelief?.paint)).toMatch(/rgba\([^)]*, 0\.\d+\)/);
  });

  it("draws the track as a zoom-dependent rounded gradient over a rim of the ground tone (MAP-008)", () => {
    for (const variant of variants) {
      const layers = trackLayers({ from: "#2f80ed", to: "#e5ed32" }, variant);
      const line = layers.find((layer) => layer.id === "obnixe-track");
      const rim = layers.find((layer) => layer.id === "obnixe-track-rim");
      expect(line?.paint).toHaveProperty("line-gradient");
      expect(JSON.stringify(line?.paint)).toContain('["zoom"]');
      expect(line?.layout).toMatchObject({ "line-cap": "round" });
      expect(rim?.paint).toMatchObject({ "line-color": variant === "dark" ? "#0b0e11" : "#ffffff" });
    }
  });
});
