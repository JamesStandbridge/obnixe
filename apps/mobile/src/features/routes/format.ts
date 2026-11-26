import type { EpochMs, Route } from "@obnixe/schema";
import { dayMonth } from "@/features/data/format";
import { formatInteger, formatNumber } from "@/format/numbers";

/** « 12,4 km · D+ 450 m », without the D+ for a route without altitude. */
export function routeFigures(row: Pick<Route, "distanceMm" | "ascentMm">): string {
  const distance = `${formatNumber(row.distanceMm / 1_000_000, 1, 1)} km`;
  return row.ascentMm === null ? distance : `${distance} · D+ ${formatInteger(row.ascentMm / 1000)} m`;
}

export function lastUsedText(lastUsedAt: EpochMs | null): string {
  return lastUsedAt === null ? "Jamais suivi" : `Suivi le ${dayMonth(lastUsedAt)}`;
}

/** `RTE-003`: « départ à 1,2 km », « départ à 80 m », « au départ » within 50 m. */
export function startDistanceText(meters: number): string {
  if (meters < 50) return "au départ";
  if (meters < 1000) return `départ à ${formatInteger(Math.round(meters / 10) * 10)} m`;
  return `départ à ${formatNumber(meters / 1000, meters < 10_000 ? 1 : 0)} km`;
}
