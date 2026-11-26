import { contourFeatures } from "@/features/maps/contourLines";
import type { ContourRequest } from "@/features/maps/contourLines";

/** The browser has no worklet runtime: the lines of a tile are traced between two frames. */
export async function traceContours(grid: Float32Array, size: number, request: ContourRequest): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return contourFeatures(grid, size, request);
}
