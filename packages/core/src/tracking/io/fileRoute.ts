import type { RoutePoint } from "../routes.ts";
import type { FileFormat } from "./activity.ts";
import { ImportError } from "./errors.ts";
import type { SportGuess } from "./sports.ts";

/** A route read from a file (`RTE-001`): its points in order; distance and D+ are measured by the engine, never read. */
export interface FileRoute {
  readonly format: FileFormat;
  readonly name: string | null;
  readonly sport: SportGuess | null;
  readonly points: readonly RoutePoint[];
}

export function fileRoute(format: FileFormat, name: string | null, sport: SportGuess | null, points: readonly RoutePoint[]): FileRoute {
  if (points.length < 2) throw new ImportError("not_a_route", "the file holds no route of two points or more");
  return { format, name, sport, points };
}
