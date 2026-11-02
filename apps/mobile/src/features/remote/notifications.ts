// The package index loads the push topic module, which Expo Go on Android does not ship, so local notification APIs are imported from their own files.
import { AndroidImportance } from "expo-notifications/build/NotificationChannelManager.types";
import { requestPermissionsAsync } from "expo-notifications/build/NotificationPermissions";
import { scheduleNotificationAsync } from "expo-notifications/build/scheduleNotificationAsync";
import { setNotificationChannelAsync } from "expo-notifications/build/setNotificationChannelAsync";

const channelId = "remote-approval";

function report(error: unknown): void {
  ErrorUtils.getGlobalHandler()(error, false);
}

/** Android 13 and later only show the permission prompt once a channel exists. */
async function ensureChannel(): Promise<void> {
  await setNotificationChannelAsync(channelId, { name: "Demandes d'accès des agents", importance: AndroidImportance.HIGH });
}

/** Asks once remote access is turned on, so authorization requests can reach the user while the app is in the background. */
export function askApprovalNotifications(): void {
  ensureChannel()
    .then(() => requestPermissionsAsync())
    .catch(report);
}

export function notifyApprovalRequest(client: string): void {
  ensureChannel()
    .then(() =>
      scheduleNotificationAsync({
        content: { title: `${client} demande l'accès à Obnixe`, body: "Ouvre l'application pour autoriser ou refuser." },
        trigger: { channelId },
      }),
    )
    .catch(report);
}
