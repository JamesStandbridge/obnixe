import { describe, expect, it } from "vitest";
import { follow, followResumeDelayMs, initialFollow } from "@/features/maps/follow";

describe("follow", () => {
  it("stops following on a gesture and resumes 15 s after the last one", () => {
    const moved = follow(initialFollow, { type: "gesture", at: 1000 });
    expect(moved.following).toBe(false);
    const again = follow(moved, { type: "gesture", at: 5000 });
    expect(follow(again, { type: "tick", at: 1000 + followResumeDelayMs }).following).toBe(false);
    expect(follow(again, { type: "tick", at: 5000 + followResumeDelayMs }).following).toBe(true);
  });

  it("recenters at once", () => {
    const moved = follow(initialFollow, { type: "gesture", at: 1000 });
    expect(follow(moved, { type: "recenter" })).toEqual(initialFollow);
  });

  it("ignores ticks while following", () => {
    expect(follow(initialFollow, { type: "tick", at: 99_999 })).toBe(initialFollow);
  });
});
