import { describe, expect, it } from "vitest";
import { defaultLoadMode, totalLoadGrams } from "./load.ts";

describe("totalLoadGrams", () => {
  it("keeps total loads as read", () => {
    expect(totalLoadGrams(45_000, { loadMode: "total", baseGrams: null })).toBe(45_000);
  });

  it("counts both implements for per hand loads", () => {
    expect(totalLoadGrams(4_000, { loadMode: "per_hand", baseGrams: null })).toBe(8_000);
  });

  it("counts both sides plus the base for per side loads", () => {
    expect(totalLoadGrams(2_500, { loadMode: "per_side", baseGrams: null })).toBe(5_000);
    expect(totalLoadGrams(10_000, { loadMode: "per_side", baseGrams: 10_000 })).toBe(30_000);
    expect(totalLoadGrams(0, { loadMode: "per_side", baseGrams: 20_000 })).toBe(20_000);
  });

  it("leaves sets without load empty", () => {
    expect(totalLoadGrams(null, { loadMode: "per_side", baseGrams: 10_000 })).toBeNull();
  });
});

describe("defaultLoadMode", () => {
  it("reads dumbbells and kettlebells per hand, everything else as a total", () => {
    expect(defaultLoadMode("dumbbell", "load_reps")).toBe("per_hand");
    expect(defaultLoadMode("kettlebell", "bodyweight_reps")).toBe("per_hand");
    expect(defaultLoadMode("barbell", "load_reps")).toBe("total");
    expect(defaultLoadMode("cable", "load_reps")).toBe("total");
    expect(defaultLoadMode("dumbbell", "duration")).toBe("total");
  });
});
