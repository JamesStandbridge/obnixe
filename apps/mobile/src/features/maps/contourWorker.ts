import { createWorkletRuntime, runOnRuntimeAsync } from "react-native-worklets";
import type { WorkletRuntime } from "react-native-worklets";
import { contourFeatures } from "@/features/maps/contourLines";
import type { ContourRequest } from "@/features/maps/contourLines";

let runtime: WorkletRuntime | null = null;

/** Traces a tile's contour lines on a worklet runtime of their own, off the JavaScript and UI threads (`MAP-006`). */
export function traceContours(grid: Float32Array, size: number, request: ContourRequest): Promise<string> {
  runtime ??= createWorkletRuntime({ name: "obnixe-contours" });
  return runOnRuntimeAsync(runtime, contourFeatures, grid, size, request);
}
