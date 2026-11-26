import { useSyncExternalStore } from "react";
import { Vibration } from "react-native";
import { addBatteryLevelListener, getBatteryLevelAsync } from "expo-battery";
import { ImpactFeedbackStyle, impactAsync } from "expo-haptics";
// The package index loads the push topic module, which Expo Go on Android does not ship, so local notification APIs are imported from their own files.
import { AndroidImportance } from "expo-notifications/build/NotificationChannelManager.types";
import { dismissNotificationAsync } from "expo-notifications/build/dismissNotificationAsync";
import { scheduleNotificationAsync } from "expo-notifications/build/scheduleNotificationAsync";
import { setNotificationChannelAsync } from "expo-notifications/build/setNotificationChannelAsync";
import type { Id } from "@obnixe/schema";
import { undo, write } from "@/data/write";
import { DerivedRebuild } from "@/features/tracking/derivedRebuild";
import type { DerivedRebuildState } from "@/features/tracking/derivedRebuild";
import { RecorderHost } from "@/features/tracking/recorderHost";
import type { RecorderFeedback, RecorderView, RecorderWriter } from "@/features/tracking/recorderHost";
import { tracker } from "../../../modules/obnixe-tracker";

const pauseChannelId = "recording-pause";
const pauseReminderId = "recording-pause-reminder";
const alertVibrationMs = 200;

function report(error: unknown): void {
  ErrorUtils.getGlobalHandler()(error, false);
}

const writer: RecorderWriter = { write, undo };

const feedback: RecorderFeedback = {
  haptic: () => {
    impactAsync(ImpactFeedbackStyle.Medium).catch(report);
  },
  alert: () => Vibration.vibrate(alertVibrationMs),
  pauseReminder: () => {
    setNotificationChannelAsync(pauseChannelId, { name: "Activité en pause", importance: AndroidImportance.DEFAULT })
      .then(() =>
        scheduleNotificationAsync({
          identifier: pauseReminderId,
          content: { title: "Activité en pause depuis 10 minutes", body: "Reprends-la ou termine-la depuis Obnixe." },
          trigger: { channelId: pauseChannelId },
        }),
      )
      .catch(report);
  },
  clearPauseReminder: () => {
    dismissNotificationAsync(pauseReminderId).catch(report);
  },
  report,
};

/** `PLT-020`: false on the web, where the screens offer no recording. */
export const recordingAvailable = tracker !== null;

/** The app's only recorder: screens read it through `useRecorderView` and act through its methods. */
export const recorder = new RecorderHost({ tracker, writer, feedback });

export const derivedRebuild = new DerivedRebuild(writer, report);

export function useRecorderView(): RecorderView {
  return useSyncExternalStore(recorder.subscribe, recorder.getView);
}

function recordingSessionId(): Id | null {
  const view = recorder.getView();
  return view.kind === "recording" ? view.recording.sessionId : null;
}

/** The session of the current recording, without the 1 Hz renders of `useRecorderView`. */
export function useRecordingSessionId(): Id | null {
  return useSyncExternalStore(recorder.subscribe, recordingSessionId);
}

export function useDerivedRebuildState(): DerivedRebuildState {
  return useSyncExternalStore(derivedRebuild.subscribe, derivedRebuild.getState);
}

/** `NRG-001`: feeds the battery level to the recorder, at every level change and while it records. */
export function watchBattery(): () => void {
  if (tracker === null) return () => undefined;
  let level = -1;
  const push = (): void => recorder.setBatteryLevel(level);
  getBatteryLevelAsync().then((value) => {
    level = value;
    push();
  }, report);
  const battery = addBatteryLevelListener((event) => {
    level = event.batteryLevel;
    push();
  });
  const unsubscribe = recorder.subscribe(push);
  return () => {
    battery.remove();
    unsubscribe();
  };
}
