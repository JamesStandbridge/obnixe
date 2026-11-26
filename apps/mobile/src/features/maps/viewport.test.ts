import { describe, expect, it } from "vitest";
import type { Bounds } from "@/features/maps/tiles";
import { fitCamera, metersPerPixel } from "@/features/maps/viewport";

const chamonix: Bounds = [6.75, 45.8, 7.1, 46.05];

describe("viewport", () => {
  it("gives the ground size of a pixel on 512 px tiles", () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(78_271.517, 2);
    expect(metersPerPixel(0, 10)).toBeCloseTo(78_271.517 / 1024, 4);
    expect(metersPerPixel(60, 0)).toBeCloseTo(78_271.517 / 2, 2);
  });

  it("fits bounds in the view, the tighter side touching the padding", () => {
    const size = { width: 360, height: 500 };
    const camera = fitCamera(chamonix, size, 20, 18);
    const [west, south, east, north] = chamonix;
    expect(camera.center[0]).toBeCloseTo((west + east) / 2, 9);
    expect(camera.center[1]).toBeGreaterThan(south);
    expect(camera.center[1]).toBeLessThan(north);
    const pixelsAcross = ((east - west) / 360) * 512 * 2 ** camera.zoom;
    expect(pixelsAcross).toBeCloseTo(size.width - 40, 6);
    const tall = fitCamera(chamonix, { width: 2000, height: 200 }, 0, 18);
    expect(tall.zoom).toBeLessThan(camera.zoom);
  });

  it("caps the zoom of tiny or empty bounds", () => {
    expect(fitCamera([6.8, 45.9, 6.8, 45.9], { width: 360, height: 360 }, 24, 15).zoom).toBe(15);
  });
});
