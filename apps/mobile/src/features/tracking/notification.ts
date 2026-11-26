import { sports } from "@obnixe/schema";
import type { EpochMs } from "@obnixe/schema";
import type { LiveSnapshot, RecorderState, ResolvedProfile, WorkoutRemaining, WorkoutStepRun, WorkoutView } from "@obnixe/core";
import type { AlertNotice } from "@/features/recording/alerts";
import { distanceLabel, stepTitle } from "@/features/workouts/format";
import { formatClock, formatLongClock } from "@/format/durations";
import { formatNumber } from "@/format/numbers";
import type { TrackerNotification, TrackerNotificationProgress } from "../../../modules/obnixe-tracker";

/** Each step of a guided workout takes the same share of the notification progress bar. */
const stepSegment = 100;

/** Instant the chronometer read zero while it runs; null while it is frozen or the recording is over. */
export function timerBaseOf(state: RecorderState, startedAt: EpochMs): EpochMs | null {
  switch (state.phase) {
    case "recording":
      return (startedAt + state.pausedMs + state.autoPausedMs) as EpochMs;
    case "preparing":
    case "auto_paused":
    case "paused":
    case "finishing":
    case "interrupted":
    case "saved":
    case "discarded":
      return null;
    default: {
      const unreachable: never = state;
      throw new Error(`Unhandled recorder state ${JSON.stringify(unreachable)}`);
    }
  }
}

function primaryText(profile: ResolvedProfile, live: LiveSnapshot): string {
  switch (profile.primary) {
    case "pace": {
      const pace = live.metrics.pace_avg;
      return pace === undefined ? "" : `Allure ${formatClock(pace)} /${profile.pacePerMeters === 1000 ? "km" : "100 m"}`;
    }
    case "speed": {
      const speed = live.metrics.speed_avg;
      return speed === undefined ? "" : `Vitesse ${formatNumber(speed * 3.6)} km/h`;
    }
    default: {
      const unreachable: never = profile.primary;
      throw new Error(`Unhandled primary metric ${String(unreachable)}`);
    }
  }
}

function remainingText(remaining: WorkoutRemaining | null): string | null {
  if (remaining === null) return null;
  switch (remaining.kind) {
    case "time":
      return `reste ${formatLongClock(Math.ceil(remaining.ms / 1000))}`;
    case "distance":
      return `reste ${distanceLabel(remaining.mm)}`;
    case "open":
      return "étape libre";
    default: {
      const unreachable: never = remaining;
      throw new Error(`Unhandled workout remaining ${JSON.stringify(unreachable)}`);
    }
  }
}

/** "Étape 3/17 · Travail · reste 240 m". */
function workoutText(workout: WorkoutView): string {
  const { current } = workout;
  if (current === null) return "Séance terminée";
  const remaining = remainingText(workout.remaining);
  return `Étape ${current.index + 1}/${workout.steps.length} · ${stepTitle(current)}${remaining === null ? "" : ` · ${remaining}`}`;
}

function stepFraction(step: WorkoutStepRun, workout: WorkoutView): number {
  switch (step.duration.kind) {
    case "time":
      return workout.stepElapsedMs / (step.duration.ms + workout.extendedMs);
    case "distance":
      return workout.stepDistanceMm / step.duration.mm;
    case "open":
      return 0;
    default: {
      const unreachable: never = step.duration;
      throw new Error(`Unhandled workout duration ${JSON.stringify(unreachable)}`);
    }
  }
}

/** `REC-074`: one segment per step, the work steps highlighted, filled up to the progress of the current step. */
export function workoutProgress(workout: WorkoutView): TrackerNotificationProgress {
  const segments = workout.steps.map((step) => ({ length: stepSegment, highlighted: step.intent === "work" }));
  const { current } = workout;
  const value = current === null ? workout.steps.length * stepSegment : current.index * stepSegment + Math.round(Math.min(1, Math.max(0, stepFraction(current, workout))) * stepSegment);
  return { segments, value };
}

/** `REC-071`, `REC-072`, `REC-075`: "Course · 5,24 km" ("Course · chronomètre" without location, `REC-060`), then a recent alert, the pause, the guided step or the main metric. */
export function notificationOf(
  profile: ResolvedProfile,
  state: RecorderState,
  live: LiveSnapshot,
  startedAt: EpochMs,
  alert: AlertNotice | null,
  workout: WorkoutView | null,
): TrackerNotification {
  const title = `${sports[profile.sport].label} · ${profile.stopwatch ? "chronomètre" : `${formatNumber(live.distanceMm / 1_000_000, 2, 2)} km`}`;
  const text =
    alert !== null
      ? `${alert.title} · ${alert.detail}`
      : state.phase === "paused"
        ? "En pause"
        : state.phase === "auto_paused"
          ? "Pause automatique"
          : workout !== null
            ? workoutText(workout)
            : primaryText(profile, live);
  return { title, text, timerBaseAt: timerBaseOf(state, startedAt), progress: workout === null ? null : workoutProgress(workout) };
}
