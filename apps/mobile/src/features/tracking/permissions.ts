import { Linking } from "react-native";
import type { ResolvedProfile } from "@obnixe/core";
import { tracker } from "../../../modules/obnixe-tracker";
import type { TrackerPermissionStatus } from "../../../modules/obnixe-tracker";

/**
 * What *Démarrer une activité* shows before the preparation screen. `explain` is Obnixe's own explanation, followed by
 * `requestLocation` (`PRV-002`); `approximate` explains why the exact position is needed, then asks for it again (`PRV-003`);
 * `denied` offers the system settings, the activity then being entered by hand.
 */
export type LocationAccess =
  | { readonly kind: "unsupported" }
  | { readonly kind: "granted" }
  | { readonly kind: "explain" }
  | { readonly kind: "approximate"; readonly canAskAgain: boolean }
  | { readonly kind: "denied"; readonly canAskAgain: boolean };

function locationAccessOf(status: TrackerPermissionStatus): LocationAccess {
  switch (status.grant) {
    case "granted":
      return { kind: "granted" };
    case "undetermined":
      return { kind: "explain" };
    case "approximate":
      return { kind: "approximate", canAskAgain: status.canAskAgain };
    case "denied":
      return { kind: "denied", canAskAgain: status.canAskAgain };
    default: {
      const unreachable: never = status.grant;
      throw new Error(`Unhandled permission grant ${String(unreachable)}`);
    }
  }
}

export async function locationAccess(): Promise<LocationAccess> {
  return tracker === null ? { kind: "unsupported" } : locationAccessOf(await tracker.getPermission("location"));
}

/** Never at launch: only from the explanation screens of `LocationAccess`. On iOS an approximate grant asks for temporary full accuracy. */
export async function requestLocation(): Promise<LocationAccess> {
  return tracker === null ? { kind: "unsupported" } : locationAccessOf(await tracker.requestPermission("location"));
}

/**
 * `PRV-005`: asked once, at the first recording of a sport showing the cadence; a refusal only leaves the pedometer off.
 * Resolves whether the pedometer may be used.
 */
export async function ensureActivityPermission(profile: ResolvedProfile): Promise<boolean> {
  if (tracker === null || profile.cadence !== "steps") return false;
  const status = await tracker.getPermission("activity");
  if (status.grant !== "undetermined") return status.grant === "granted";
  return (await tracker.requestPermission("activity")).grant === "granted";
}

/** `PRV-006`: asked on the first press of *Connecter une source cardiaque* only; a refusal never blocks the recording. */
export async function requestBluetooth(): Promise<boolean> {
  if (tracker === null) return false;
  const status = await tracker.getPermission("bluetooth");
  if (status.grant === "granted") return true;
  if (!status.canAskAgain) return false;
  return (await tracker.requestPermission("bluetooth")).grant === "granted";
}

export function openSystemSettings(): void {
  Linking.openSettings().catch((error: unknown) => ErrorUtils.getGlobalHandler()(error, false));
}
