import type { HeartRateZone, ResolvedProfile } from "@obnixe/core";
import { autoLapDurationsMs, autoLapMeters, sportKeys } from "@obnixe/schema";
import type { HeartRateRange, PaceRange, RecordingAlert, RecordingSettings, SportKey } from "@obnixe/schema";
import { heartRateSpan } from "@/features/recording/alerts";
import { paceRangeText } from "@/features/workouts/format";
import { formatNumber } from "@/format/numbers";

export type AutoLap = RecordingSettings["autoLap"];

export function isSportKey(value: string): value is SportKey {
  return (sportKeys as readonly string[]).includes(value);
}

export interface AlertLabel {
  readonly title: string;
  readonly detail: string;
}

/** `REC-075`: each alert type the sport can switch off, in the order of the settings screen. */
export function alertLabel(alert: RecordingAlert, profile: Pick<ResolvedProfile, "splitMeters">): AlertLabel {
  switch (alert) {
    case "lap":
      return { title: "Tours", detail: "Manuels et automatiques" };
    case "split":
      return { title: "Splits", detail: profile.splitMeters === null ? "Sans split pour ce sport" : `Tous les ${distanceLabel(profile.splitMeters)}, sans tour automatique` };
    case "goal":
      return { title: "Objectif atteint", detail: "Distance ou durée de la séance du programme" };
    case "auto_pause":
      return { title: "Pause et reprise automatiques", detail: "Quand tu t'arrêtes et repars" };
    case "segment":
      return { title: "Segments", detail: "À l'entrée, puis le temps et l'écart au meilleur passage" };
    case "route":
      return { title: "Sortie d'itinéraire", detail: "Hors de l'itinéraire suivi, puis de retour dessus" };
    case "gps":
      return { title: "Signal GPS", detail: "Perdu puis retrouvé" };
    case "sensor":
      return { title: "Capteur cardiaque", detail: "Perdu puis reconnecté" };
    case "battery":
      return { title: "Batterie", detail: "Sous 15 %, puis sous 5 %" };
    default: {
      const unreachable: never = alert;
      throw new Error(`Unhandled alert ${String(unreachable)}`);
    }
  }
}

export function withAlert(settings: RecordingSettings, alert: RecordingAlert, enabled: boolean): RecordingSettings {
  const disabled = settings.alerts.disabled.filter((key) => key !== alert);
  return { ...settings, alerts: { ...settings.alerts, disabled: enabled ? disabled : [...disabled, alert] } };
}

export type AutoLapChoice = "none" | `distance:${number}` | `duration:${number}`;

export interface AutoLapOption {
  readonly value: AutoLapChoice;
  readonly label: string;
  readonly autoLap: AutoLap;
}

function distanceLabel(meters: number): string {
  return meters < 1000 ? `${meters} m` : `${formatNumber(meters / 1000, 0)} km`;
}

export function autoLapLabel(autoLap: AutoLap): string {
  if (autoLap === null) return "Aucun";
  switch (autoLap.trigger) {
    case "distance":
      return `Tous les ${distanceLabel(autoLap.meters)}`;
    case "duration":
      return `Toutes les ${formatNumber(autoLap.ms / 60_000, 0)} min`;
    default: {
      const unreachable: never = autoLap;
      throw new Error(`Unhandled auto lap ${JSON.stringify(unreachable)}`);
    }
  }
}

export const autoLapOptions: readonly AutoLapOption[] = [
  { value: "none", label: "Aucun", autoLap: null },
  ...autoLapMeters.map((meters): AutoLapOption => ({ value: `distance:${meters}`, label: distanceLabel(meters), autoLap: { trigger: "distance", meters } })),
  ...autoLapDurationsMs.map((ms): AutoLapOption => ({ value: `duration:${ms}`, label: `${formatNumber(ms / 60_000, 0)} min`, autoLap: { trigger: "duration", ms } })),
];

export function autoLapChoiceOf(autoLap: AutoLap): AutoLapChoice {
  if (autoLap === null) return "none";
  return autoLap.trigger === "distance" ? `distance:${autoLap.meters}` : `duration:${autoLap.ms}`;
}

const pace = (fastestSecondsPerKm: number, slowestSecondsPerKm: number): PaceRange => ({ kind: "pace", fastestSecondsPerKm, slowestSecondsPerKm });
const speed = (minKmhTenths: number, maxKmhTenths: number): PaceRange => ({ kind: "speed", minMmS: kmhTenthsToMmS(minKmhTenths), maxMmS: kmhTenthsToMmS(maxKmhTenths) });

/** The span a sport starts from when its alert is switched on, in its primary measure. */
export function defaultPaceRange(profile: Pick<ResolvedProfile, "sport">): PaceRange {
  switch (profile.sport) {
    case "walk":
      return pace(600, 720);
    case "nordic_ski":
      return pace(240, 330);
    case "swim":
      return pace(1200, 1500);
    case "hike":
      return speed(30, 50);
    case "ski_touring":
      return speed(20, 40);
    case "alpine_ski":
      return speed(300, 500);
    case "paddle":
      return speed(60, 90);
    case "inline_skate":
      return speed(150, 220);
    case "bike":
      return speed(250, 300);
    case "run":
    case "trail":
    case "strength":
    case "climb":
    case "yoga":
      return pace(300, 360);
    default: {
      const unreachable: never = profile.sport;
      throw new Error(`Unhandled sport ${String(unreachable)}`);
    }
  }
}

export const paceStepSeconds = 5;
export const speedStepKmhTenths = 5;
export const speedBoundsKmhTenths = { min: 20, max: 1080 } as const;

export interface PaceBounds {
  readonly min: number;
  readonly max: number;
}

/** Bounds of a pace target in seconds per `pacePerMeters`. */
export function paceBoundsOf(profile: Pick<ResolvedProfile, "pacePerMeters">): PaceBounds {
  return profile.pacePerMeters === 100 ? { min: 60, max: 300 } : { min: 120, max: 1800 };
}

export function kmhTenthsToMmS(tenths: number): number {
  return Math.round((tenths * 100) / 3.6);
}

export function mmSToKmhTenths(mmS: number): number {
  return Math.round((mmS * 3.6) / 100);
}

export function formatKmhTenths(tenths: number): string {
  return formatNumber(tenths / 10, 1, 1);
}

export function paceRangeLabel(range: PaceRange | null, profile: Pick<ResolvedProfile, "pacePerMeters">): string {
  if (range === null) return "Aucune";
  switch (range.kind) {
    case "pace":
      return paceRangeText(range, profile);
    case "speed":
      return `${formatKmhTenths(mmSToKmhTenths(range.minMmS))} – ${formatKmhTenths(mmSToKmhTenths(range.maxMmS))} km/h`;
    default: {
      const unreachable: never = range;
      throw new Error(`Unhandled pace range ${JSON.stringify(unreachable)}`);
    }
  }
}

export function heartRateRangeLabel(range: HeartRateRange | null): string {
  return range === null ? "Aucune" : heartRateSpan(range);
}

/** Moves one end of the span, dragging the other along so the lowest zone never passes the highest. */
export function withZoneEnd(range: HeartRateRange, end: "lowest" | "highest", zone: HeartRateZone): HeartRateRange {
  if (end === "lowest") return { lowest: zone, highest: zone > range.highest ? zone : range.highest };
  return { lowest: zone < range.lowest ? zone : range.lowest, highest: zone };
}

/** One line under the sport in the settings: what departs from the defaults. */
export function settingsSummary(settings: RecordingSettings): string {
  const parts = [
    settings.autoPause ? "pause auto" : "sans pause auto",
    ...(settings.autoLap === null ? [] : [`tours ${autoLapLabel(settings.autoLap).toLowerCase()}`]),
    ...(settings.alerts.disabled.length === 0 ? [] : [`${settings.alerts.disabled.length} alerte${settings.alerts.disabled.length > 1 ? "s" : ""} coupée${settings.alerts.disabled.length > 1 ? "s" : ""}`]),
    ...(settings.heartRateDevice === null ? [] : [settings.heartRateDevice.name]),
  ];
  return parts.join(" · ");
}
