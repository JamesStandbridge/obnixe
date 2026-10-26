import { Linking } from "react-native";
import { useRestAlertAccess } from "@/features/training/workout/useRestAlert";
import type { RestAlertAccess } from "@/features/training/workout/useRestAlert";
import { Chevron } from "@/features/data/parts";
import { Row } from "@/ui/Layout";

type RestAlertState = "unknown" | "granted" | "denied" | "paused" | "ask";

function stateOf(access: RestAlertAccess): RestAlertState {
  switch (access.permission) {
    case null:
      return "unknown";
    case "granted":
      return "granted";
    case "denied":
      return "denied";
    case "ask":
      return access.declined ? "paused" : "ask";
    default: {
      const unreachable: never = access.permission;
      return unreachable;
    }
  }
}

function openSystemSettings(): void {
  Linking.openSettings().catch((error: unknown) => ErrorUtils.getGlobalHandler()(error, false));
}

export function RestAlertsRow() {
  const access = useRestAlertAccess();
  const state = stateOf(access);
  const title = "Notifications de fin de repos";
  switch (state) {
    case "unknown":
      return <Row title={title} last />;
    case "granted":
      return <Row title={title} detail="autorisées" trailing={<Chevron />} onPress={openSystemSettings} last />;
    case "denied":
      return <Row title={title} detail="refusées dans les réglages du système" trailing={<Chevron />} onPress={openSystemSettings} last />;
    case "paused":
      return <Row title={title} detail="en pause" trailing={<Chevron />} onPress={access.request} last />;
    case "ask":
      return <Row title={title} detail="pas encore autorisées" trailing={<Chevron />} onPress={access.request} last />;
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}
