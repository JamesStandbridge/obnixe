import { describe, expect, it } from "vitest";
import { sports } from "@obnixe/schema";
import type { MotionThresholds } from "@obnixe/schema";
import { CadenceMeter, classifyIntervals, MotionClassifier } from "./motion.ts";
import type { MotionInput, MotionState } from "./motion.ts";

const runMotion: MotionThresholds = (sports.run.recording ?? sports.hike.recording).motion;
const hikeMotion: MotionThresholds = (sports.hike.recording ?? sports.run.recording).motion;

const input = (seconds: number, speed: number, overrides: Partial<MotionInput> = {}): MotionInput => ({
  t: seconds * 1000,
  speed,
  verticalSpeed: null,
  cadence: null,
  accuracy: 4,
  paused: false,
  ...overrides,
});

const states = (motion: MotionThresholds, inputs: readonly MotionInput[]): MotionState[] => {
  const classifier = new MotionClassifier(motion);
  return inputs.map((value) => classifier.push(value));
};

describe("MotionClassifier", () => {
  it("starts once the start speed held for the start delay, backdated to its onset (GPS-033)", () => {
    const classifier = new MotionClassifier(runMotion);
    expect(classifier.since).toBeNull();
    expect(classifier.push(input(0, 0))).toBe("stopped");
    expect(classifier.push(input(1, 2))).toBe("stopped");
    expect(classifier.push(input(2, 2))).toBe("moving");
    expect(classifier.since).toBe(0);
  });

  it("keeps moving between the two thresholds and stops after the stop delay (GPS-033)", () => {
    const speeds = [2, 2, 2, 0.8, 0.8, 0.3, 0.3, 0.3, 0.3, 0.3];
    expect(states(runMotion, speeds.map((speed, index) => input(index, speed)))).toEqual(["stopped", "stopped", "moving", "moving", "moving", "moving", "moving", "moving", "stopped", "stopped"]);
  });

  it("stops at once on a manual pause (GPS-033)", () => {
    expect(states(runMotion, [input(0, 3), input(1, 3), input(2, 3), input(3, 3, { paused: true }), input(4, 3)])).toEqual(["stopped", "stopped", "moving", "stopped", "stopped"]);
  });

  it("moves on a steep climb at walking pace through the vertical speed (GPS-033)", () => {
    const climb = Array.from({ length: 6 }, (_, index) => input(index, 0.25, { verticalSpeed: 0.15 }));
    expect(states(hikeMotion, climb).at(-1)).toBe("moving");
    const flat = Array.from({ length: 6 }, (_, index) => input(index, 0.25, { verticalSpeed: 0.02 }));
    expect(states(hikeMotion, flat).at(-1)).toBe("stopped");
  });

  it("lets the cadence decide when the fixes are inaccurate (GPS-034)", () => {
    const wandering = Array.from({ length: 8 }, (_, index) => input(index, 1.8, { cadence: 0, accuracy: 25 }));
    expect(states(runMotion, wandering)).not.toContain("moving");
    const accurate = wandering.map((value) => ({ ...value, accuracy: 6 }));
    expect(states(runMotion, accurate).at(-1)).toBe("moving");
    const striding = wandering.map((value) => ({ ...value, speed: 0, cadence: 160 }));
    expect(states(runMotion, striding).at(-1)).toBe("moving");
  });

  it("does not stop while the cadence stays above its stop threshold (GPS-034)", () => {
    const inputs = [input(0, 3), input(1, 3), input(2, 3), ...Array.from({ length: 8 }, (_, index) => input(3 + index, 0.2, { cadence: 90 }))];
    expect(states(runMotion, inputs).at(-1)).toBe("moving");
  });
});

describe("classifyIntervals", () => {
  it("applies each switch from the onset of its condition", () => {
    const speeds = [0, 0, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0];
    expect([...classifyIntervals(runMotion, speeds.map((speed, index) => input(index, speed)))]).toEqual([0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
  });

  it("leaves a short slowdown moving", () => {
    const speeds = [0, 3, 3, 3, 0, 0, 3, 3, 3];
    expect([...classifyIntervals(runMotion, speeds.map((speed, index) => input(index, speed)))]).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1]);
  });
});

describe("CadenceMeter", () => {
  it("measures steps per minute over the trailing window", () => {
    const meter = new CadenceMeter();
    expect(meter.at(0)).toBeNull();
    for (let second = 0; second <= 20; second += 1) meter.push({ type: "steps", t: second * 1000, count: 3 * second });
    expect(meter.at(20_000)).toBe(180);
    meter.push({ type: "steps", t: 21_000, count: 61 });
    expect(meter.at(21_000)).toBe(((61 - 48) * 60_000) / 5000);
  });

  it("scales a partial window to its span", () => {
    const meter = new CadenceMeter();
    meter.push({ type: "steps", t: 0, count: 0 });
    meter.push({ type: "steps", t: 2000, count: 4 });
    expect(meter.at(2000)).toBe(120);
    expect(meter.at(0)).toBe(0);
  });
});
