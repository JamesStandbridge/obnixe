import { describe, expect, it } from "vitest";
import { areaPath, axisTicks, linePath, paddedRange, project, unproject, valueTicks } from "@/features/recordings/chartGeometry";

const x = { min: 0, max: 100, from: 0, to: 200 };
const y = { min: 0, max: 10, from: 50, to: 0 };

describe("chart geometry (SUM-002)", () => {
  it("projects values onto pixels and back, upwards for values", () => {
    expect(project(x, 50)).toBe(100);
    expect(project(y, 10)).toBe(0);
    expect(unproject(x, 150)).toBe(75);
    expect(project({ min: 3, max: 3, from: 0, to: 10 }, 3)).toBe(5);
  });

  it("breaks the line at unknown values and clamps it to the plot", () => {
    const line = { x: Float64Array.from([0, 50, 60, 100]), y: Float64Array.from([5, 20, Number.NaN, 0]) };
    expect(linePath(line, x, y)).toBe("M0.0,25.0L100.0,0.0M200.0,50.0");
    expect(areaPath(line, x, y, 50)).toBe("M0.0,25.0L100.0,0.0L100.0,50.0L0.0,50.0ZM200.0,50.0L200.0,50.0L200.0,50.0Z");
  });

  it("picks round ticks inside the range", () => {
    expect(valueTicks({ min: 212, max: 487 }, 3)).toEqual([300, 400]);
    expect(valueTicks({ min: 212, max: 487 }, 6)).toEqual([250, 300, 350, 400, 450]);
    expect(valueTicks({ min: 0, max: 1 }, 4)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("spaces axis ticks by round distances or durations", () => {
    expect(axisTicks("distance", 10_400, 320, 48)).toEqual([2000, 4000, 6000, 8000, 10_000]);
    expect(axisTicks("time", 6 * 3_600_000, 320, 48)).toEqual([3_600_000, 7_200_000, 10_800_000, 14_400_000, 18_000_000]);
  });

  it("never lets a flat profile fill the plot", () => {
    expect(paddedRange({ min: 300, max: 302 }, 20, 0.1)).toEqual({ min: 289, max: 313 });
  });
});
