import { Platform } from "react-native";
import {
  AndroidImportance,
  cancelScheduledNotificationAsync,
  getPermissionsAsync,
  requestPermissionsAsync,
  scheduleNotificationAsync,
  SchedulableTriggerInputTypes,
  setNotificationChannelAsync,
  setNotificationHandler,
} from "expo-notifications";
import type { NotificationPermissionsStatus } from "expo-notifications";

export type RestAlertPermission = "granted" | "denied" | "ask";

/** Android 13 and later report "refused" both before the first prompt and after a refusal that may still be asked again. */
export type RestAlertSystemState = "granted" | "blocked" | "refused" | "undetermined";

export interface RestAlert {
  readonly endsAt: number;
  readonly body: string;
}

const channelId = "rest";
const identifier = "rest-end";

let pending: Promise<void> = Promise.resolve();

/** Schedule and cancel calls run one after the other so a late cancel never removes a newer rest. */
function enqueue(task: () => Promise<void>): void {
  pending = pending.then(task).catch((error: unknown) => ErrorUtils.getGlobalHandler()(error, false));
}

export function configureRestAlerts(): void {
  setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false }),
  });
}

function systemStateOf(status: NotificationPermissionsStatus): RestAlertSystemState {
  if (status.granted) return "granted";
  if (!status.canAskAgain) return "blocked";
  return status.status === "denied" ? "refused" : "undetermined";
}

export async function restAlertSystemState(): Promise<RestAlertSystemState> {
  return systemStateOf(await getPermissionsAsync());
}

/** Android 13 and later only show the permission prompt once a channel exists. */
async function ensureChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await setNotificationChannelAsync(channelId, { name: "Fin du repos", importance: AndroidImportance.HIGH, vibrationPattern: [0, 250, 120, 250] });
}

export async function requestRestAlerts(): Promise<RestAlertSystemState> {
  await ensureChannel();
  return systemStateOf(await requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } }));
}

/** The fixed identifier makes each schedule replace the previous one, even one left by a killed app. */
export function scheduleRestAlert(alert: RestAlert): void {
  enqueue(async () => {
    await ensureChannel();
    await scheduleNotificationAsync({
      identifier,
      content: { title: "Repos terminé", body: alert.body, sound: true },
      trigger: { type: SchedulableTriggerInputTypes.DATE, date: alert.endsAt, channelId },
    });
  });
}

export function cancelRestAlert(): void {
  enqueue(() => cancelScheduledNotificationAsync(identifier));
}
