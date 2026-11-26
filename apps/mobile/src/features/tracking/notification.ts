import { sports } from "@obnixe/schema";
import type { EpochMs } from "@obnixe/schema";
import type { LiveSnapshot, RecorderState, ResolvedProfile } from "@obnixe/core";
import type { AlertNotice } from "@/features/recording/alerts";
import { formatClock } from "@/format/durations";
import { formatNumber } from "@/format/numbers";
import type { TrackerNotification } from "../../../modules/obnixe-tracker";

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

/** `REC-071`, `REC-072`, `REC-075`: "Course · 5,24 km", then a recent alert, the pause or the main metric. */
export function notificationOf(profile: ResolvedProfile, state: RecorderState, live: LiveSnapshot, startedAt: EpochMs, alert: AlertNotice | null): TrackerNotification {
  const title = `${sports[profile.sport].label} · ${formatNumber(live.distanceMm / 1_000_000, 2, 2)} km`;
  const text = alert !== null ? `${alert.title} · ${alert.detail}` : state.phase === "paused" ? "En pause" : state.phase === "auto_paused" ? "Pause automatique" : primaryText(profile, live);
  return { title, text, timerBaseAt: timerBaseOf(state, startedAt) };
}
