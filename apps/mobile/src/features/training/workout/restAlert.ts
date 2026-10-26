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

export interface RestAlert {
  readonly endsAt: number;
  readonly body: string;
}

const channelId = "rest";

setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false }),
});

function permissionOf(status: NotificationPermissionsStatus): RestAlertPermission {
  if (status.granted) return "granted";
  return status.canAskAgain ? "ask" : "denied";
}

export async function restAlertPermission(): Promise<RestAlertPermission> {
  return permissionOf(await getPermissionsAsync());
}

/** Android 13 and later only show the permission prompt once a channel exists. */
async function ensureChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await setNotificationChannelAsync(channelId, { name: "Fin du repos", importance: AndroidImportance.HIGH, vibrationPattern: [0, 250, 120, 250] });
}

export async function requestRestAlerts(): Promise<RestAlertPermission> {
  await ensureChannel();
  return permissionOf(await requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } }));
}

export async function scheduleRestAlert(alert: RestAlert): Promise<string> {
  await ensureChannel();
  return scheduleNotificationAsync({
    content: { title: "Repos terminé", body: alert.body, sound: true },
    trigger: { type: SchedulableTriggerInputTypes.DATE, date: alert.endsAt, channelId },
  });
}

export async function cancelRestAlert(id: string): Promise<void> {
  await cancelScheduledNotificationAsync(id);
}
