import { describe, expect, it } from "vitest";
import { palettes } from "@/ui/tokens";
import type { PaletteName } from "@/ui/tokens";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe("live screen legibility (UX-001)", () => {
  it("keeps the figures and their units at WCAG 2.2 AA contrast in both themes", () => {
    for (const name of ["dark", "sunlight"] as const satisfies readonly PaletteName[]) {
      const palette = palettes[name];
      for (const background of [palette.bg, palette.surface]) {
        expect(contrast(palette.text, background), `${name} text`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(palette.text2, background), `${name} text2`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
