import { heartRateZones } from "@obnixe/core";
import type { AlertGoal, RangeStatus, RecordingAlertEvent, ResolvedProfile, RouteRejoin, WorkoutStepRun } from "@obnixe/core";
import type { HeartRateRange, PaceRange, WorkoutDuration, WorkoutIntent, WorkoutTarget } from "@obnixe/schema";
import { lapFigures } from "@/features/recording/metrics";
import { targetLabel } from "@/features/recording/target";
import { formatClock, formatLongClock } from "@/format/durations";
import { formatInteger, formatNumber } from "@/format/numbers";

export type AlertTone = "mark" | "warn" | "stop";

/** What the live banner and the notification say of an alert (`REC-075`). */
export interface AlertNotice {
  readonly title: string;
  readonly detail: string;
  readonly tone: AlertTone;
}

/** Vibration then silence, alternately, in milliseconds, starting with a vibration. */
export type AlertPulses = readonly number[];

const short = 100;
const gap = 120;

const pulses = {
  single: [200],
  double: [200, 150, 200],
  triple: [short, gap, short, gap, short],
  back: [short, gap, short],
  long: [500],
  rising: [short, gap, 300],
  warning: [300, 200, 300],
  entering: [300, gap, short],
  finishing: [short, gap, short, gap, 300],
} as const satisfies Readonly<Record<string, AlertPulses>>;

/**
 * `REC-075`: a vibration per alert type, one for a lap or a split, two for a reached target, three short ones out of a span,
 * long then short on entering a segment, short twice then long at its end (`SEG-004`).
 */
export function alertPulses(event: RecordingAlertEvent): AlertPulses {
  switch (event.kind) {
    case "lap":
    case "split":
      return pulses.single;
    case "goal":
    case "workout_step":
      return pulses.double;
    case "pace_range":
    case "heart_rate_range":
    case "workout_target":
    case "route":
      return event.status === "back" ? pulses.back : pulses.triple;
    case "auto_pause":
      return pulses.long;
    case "auto_resume":
      return pulses.rising;
    case "gps":
    case "sensor":
      return event.change === "back" ? pulses.back : pulses.long;
    case "battery":
      return pulses.warning;
    case "segment_entered":
      return pulses.entering;
    case "segment_finished":
      return pulses.finishing;
    default: {
      const unreachable: never = event;
      throw new Error(`Unhandled alert ${JSON.stringify(unreachable)}`);
    }
  }
}

/** iOS vibrates for a fixed duration, so its pattern only spaces the vibrations out. */
const iosVibrationMs = 400;

/**
 * The `Vibration.vibrate` pattern of the pulses: on Android, waits and vibrations alternate from a first wait; on iOS, a
 * first vibration at once, then the wait before each next one.
 */
export function vibrationPattern(alert: AlertPulses, os: "ios" | "android"): number[] {
  if (os === "android") return [0, ...alert];
  const pattern = [0];
  for (let index = 0; index + 2 < alert.length; index += 2) pattern.push(Math.max(iosVibrationMs, alert[index] ?? 0) + (alert[index + 1] ?? 0));
  return pattern;
}

function paceSpan(range: PaceRange): string {
  switch (range.kind) {
    case "pace":
      return `${formatClock(range.fastestSecondsPerKm)} – ${formatClock(range.slowestSecondsPerKm)} /km`;
    case "speed":
      return `${formatNumber(range.minMmS * 0.0036)} – ${formatNumber(range.maxMmS * 0.0036)} km/h`;
    default: {
      const unreachable: never = range;
      throw new Error(`Unhandled pace range ${JSON.stringify(unreachable)}`);
    }
  }
}

export function heartRateSpan(range: HeartRateRange): string {
  return range.lowest === range.highest ? `Z${range.lowest}` : `Z${range.lowest} – Z${range.highest}`;
}

function paceTitle(range: PaceRange, status: RangeStatus["status"]): string {
  const measure = range.kind === "pace" ? "Allure" : "Vitesse";
  switch (status) {
    case "below":
      return range.kind === "pace" ? "Allure trop lente" : "Vitesse trop basse";
    case "above":
      return range.kind === "pace" ? "Allure trop rapide" : "Vitesse trop haute";
    case "back":
      return `${measure} dans la cible`;
    default: {
      const unreachable: never = status;
      throw new Error(`Unhandled range status ${String(unreachable)}`);
    }
  }
}

function heartRateTitle(status: RangeStatus["status"]): string {
  switch (status) {
    case "below":
      return "Cardio trop bas";
    case "above":
      return "Cardio trop haut";
    case "back":
      return "Cardio dans la cible";
    default: {
      const unreachable: never = status;
      throw new Error(`Unhandled range status ${String(unreachable)}`);
    }
  }
}

/** The gap to the best pass, « −0:05 » when faster. */
function segmentGapText(elapsedMs: number, bestElapsedMs: number): string {
  const seconds = Math.round((elapsedMs - bestElapsedMs) / 1000);
  return `${seconds < 0 ? "−" : "+"}${formatClock(Math.abs(seconds))}`;
}

function segmentFinishDetail(elapsedMs: number, bestElapsedMs: number | null): string {
  if (bestElapsedMs === null) return "Premier passage";
  const gap = segmentGapText(elapsedMs, bestElapsedMs);
  return elapsedMs < bestElapsedMs ? `Meilleur passage, ${gap}` : `${gap} sur le meilleur passage`;
}

const intentLabels: Readonly<Record<WorkoutIntent, string>> = {
  warmup: "Échauffement",
  work: "Travail",
  recovery: "Récupération",
  rest: "Repos",
  cooldown: "Retour au calme",
};

function durationLabel(duration: WorkoutDuration): string {
  switch (duration.kind) {
    case "time":
      return formatLongClock(duration.ms / 1000);
    case "distance":
      return duration.mm < 1_000_000 ? `${formatNumber(duration.mm / 1000, 0)} m` : `${formatNumber(duration.mm / 1_000_000, 2)} km`;
    case "open":
      return "Jusqu'à l'étape suivante";
    default: {
      const unreachable: never = duration;
      throw new Error(`Unhandled workout duration ${JSON.stringify(unreachable)}`);
    }
  }
}

function workoutTargetSpan(target: Exclude<WorkoutTarget, { readonly kind: "none" }>): string {
  switch (target.kind) {
    case "pace":
    case "speed":
      return paceSpan(target);
    case "heart_rate_zone":
      return `Z${target.zone}`;
    case "heart_rate":
      return `${target.minBpm} – ${target.maxBpm} bpm`;
    default: {
      const unreachable: never = target;
      throw new Error(`Unhandled workout target ${JSON.stringify(unreachable)}`);
    }
  }
}

function stepNotice(step: WorkoutStepRun | null): AlertNotice {
  if (step === null) return { title: "Séance terminée", detail: "Toutes les étapes sont faites", tone: "mark" };
  const parts = [
    ...(step.repetition === null ? [] : [`Répétition ${step.repetition.number}/${step.repetition.count}`]),
    durationLabel(step.duration),
    ...(step.target.kind === "none" ? [] : [workoutTargetSpan(step.target)]),
  ];
  return { title: step.label ?? intentLabels[step.intent], detail: parts.join(" · "), tone: "mark" };
}

function workoutTargetNotice(target: WorkoutTarget, status: RangeStatus["status"]): AlertNotice {
  if (target.kind === "none") throw new Error("A step without a target raised a target alert");
  const title = target.kind === "pace" || target.kind === "speed" ? paceTitle(target, status) : heartRateTitle(status);
  return { title, detail: `Cible ${workoutTargetSpan(target)}`, tone: status === "back" ? "mark" : "warn" };
}

const compassPoints = ["au nord", "au nord-est", "à l'est", "au sud-est", "au sud", "au sud-ouest", "à l'ouest", "au nord-ouest"] as const;

/** `RTE-005`: where the route is from the position, « à 80 m au sud-est ». */
export function rejoinText(rejoin: Pick<RouteRejoin, "distance" | "bearing">): string {
  const point = compassPoints[Math.round((((rejoin.bearing % 360) + 360) % 360) / 45) % compassPoints.length] ?? compassPoints[0];
  const distance = rejoin.distance < 1000 ? `${formatInteger(Math.round(rejoin.distance / 10) * 10)} m` : `${formatNumber(rejoin.distance / 1000, 1, 1)} km`;
  return `à ${distance} ${point}`;
}

function goalDetail(goal: AlertGoal): string {
  return `Objectif ${targetLabel(goal)} atteint`;
}

export function alertNotice(event: RecordingAlertEvent, profile: Pick<ResolvedProfile, "primary" | "pacePerMeters">): AlertNotice {
  switch (event.kind) {
    case "lap": {
      const figures = lapFigures(event.lap, profile);
      return { title: figures.title, detail: `${figures.duration} · ${figures.distance.value} ${figures.distance.unit} · ${figures.rate.value} ${figures.rate.unit}`, tone: "mark" };
    }
    case "split": {
      const figures = lapFigures({ index: event.index - 1, startMs: 0, elapsedMs: event.movingMs, movingMs: event.movingMs, distanceMm: event.meters * 1000 }, profile);
      const title = event.meters === 1000 ? `Kilomètre ${event.index}` : `${formatNumber((event.index * event.meters) / 1000, 0)} km`;
      return { title, detail: `${figures.duration} · ${figures.rate.value} ${figures.rate.unit}`, tone: "mark" };
    }
    case "auto_pause":
      return { title: "Pause auto", detail: "Le chronomètre reprend dès que tu bouges", tone: "warn" };
    case "auto_resume":
      return { title: "Reprise", detail: "Le chronomètre repart", tone: "mark" };
    case "goal":
      return { title: "Objectif atteint", detail: goalDetail(event.goal), tone: "mark" };
    case "pace_range":
      return { title: paceTitle(event.range, event.status), detail: `Cible ${paceSpan(event.range)}`, tone: event.status === "back" ? "mark" : "warn" };
    case "heart_rate_range":
      return { title: heartRateTitle(event.status), detail: `Cible ${heartRateSpan(event.range)}`, tone: event.status === "back" ? "mark" : "warn" };
    case "segment_entered":
      return { title: `Segment ${event.name}`, detail: event.bestElapsedMs === null ? "Premier passage, chrono lancé" : `Meilleur passage ${formatLongClock(event.bestElapsedMs / 1000)}`, tone: "mark" };
    case "segment_finished":
      return { title: `${event.name} · ${formatLongClock(event.elapsedMs / 1000)}`, detail: segmentFinishDetail(event.elapsedMs, event.bestElapsedMs), tone: "mark" };
    case "route":
      if (event.status === "back") return { title: "De retour sur l'itinéraire", detail: "Le suivi reprend", tone: "mark" };
      return { title: "Hors itinéraire", detail: event.rejoin === null ? "Reviens sur le tracé" : `L'itinéraire est ${rejoinText(event.rejoin)}`, tone: "warn" };
    case "workout_step":
      return stepNotice(event.step);
    case "workout_target":
      return workoutTargetNotice(event.step.target, event.status);
    case "gps":
      return event.change === "lost"
        ? { title: "Signal GPS perdu", detail: "La distance reprend au retour du signal", tone: "warn" }
        : { title: "Signal GPS retrouvé", detail: "La trace continue", tone: "mark" };
    case "sensor":
      return event.change === "lost"
        ? { title: "Capteur cardiaque perdu", detail: "Reconnexion en cours", tone: "warn" }
        : { title: "Capteur cardiaque reconnecté", detail: "La fréquence cardiaque reprend", tone: "mark" };
    case "battery":
      return event.level === "low"
        ? { title: "Batterie faible", detail: "Moins de 15 % : le mode économie espace les points GPS", tone: "warn" }
        : { title: "Batterie critique", detail: "Moins de 5 % : points GPS espacés au maximum", tone: "stop" };
    default: {
      const unreachable: never = event;
      throw new Error(`Unhandled alert ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The heart-rate zones of a span as bpm, for the settings screen; null without a maximum heart rate. */
export function heartRateSpanBpm(range: HeartRateRange, maxHeartRate: number | null): string | null {
  if (maxHeartRate === null) return null;
  const zones = heartRateZones(maxHeartRate);
  const lowest = zones.find((zone) => zone.zone === range.lowest);
  const highest = zones.find((zone) => zone.zone === range.highest);
  if (lowest === undefined || highest === undefined) return null;
  const low = Math.round(lowest.minBpm);
  const high = Math.round(highest.maxBpm);
  return range.highest === 5 ? `dès ${low} bpm` : `${low} – ${high} bpm`;
}

const sampleRate = 22_050;

/** A short 880 Hz beep with soft edges as a 16-bit mono WAV, so no audio asset ships (`REC-075`). */
export function beepWave(durationMs = 140, frequency = 880): Uint8Array {
  const samples = Math.round((sampleRate * durationMs) / 1000);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  const edge = Math.round(sampleRate * 0.01);
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.min(1, index / edge, (samples - 1 - index) / edge);
    view.setInt16(44 + index * 2, Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * envelope * 0.6 * 0x7fff), true);
  }
  return bytes;
}
