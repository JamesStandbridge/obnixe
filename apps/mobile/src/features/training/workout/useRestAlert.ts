import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { settings } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { updateSettings } from "@/data/settings";
import { cancelRestAlert, requestRestAlerts, restAlertSystemState, scheduleRestAlert } from "@/features/training/workout/restAlert";
import type { RestAlertPermission, RestAlertSystemState } from "@/features/training/workout/restAlert";

export interface RestAlertRequest {
  readonly restId: string;
  readonly endsAt: number;
  readonly body: string;
}

export interface RestAlertPrompt {
  readonly explaining: boolean;
  readonly allow: () => void;
  readonly later: () => void;
}

function reportFailure(error: unknown): void {
  ErrorUtils.getGlobalHandler()(error, false);
}

export interface RestAlertAccess {
  readonly permission: RestAlertPermission | null;
  readonly declined: boolean;
  readonly request: () => void;
}

function permissionOf(system: RestAlertSystemState | null, asked: boolean): RestAlertPermission | null {
  switch (system) {
    case null:
      return null;
    case "granted":
      return "granted";
    case "blocked":
      return "denied";
    case "refused":
      return asked ? "denied" : "ask";
    case "undetermined":
      return "ask";
    default: {
      const unreachable: never = system;
      return unreachable;
    }
  }
}

/** Tracks the system permission, refreshed whenever the app comes back to the foreground, and the in-app postponement. */
export function useRestAlertAccess(): RestAlertAccess {
  const [system, setSystem] = useState<RestAlertSystemState | null>(null);
  const { data: settingsRows } = useLiveQuery(db().select({ declinedAt: settings.restAlertsDeclinedAt, askedAt: settings.restAlertsAskedAt }).from(settings));
  const declined = (settingsRows[0]?.declinedAt ?? null) !== null;
  const permission = permissionOf(system, (settingsRows[0]?.askedAt ?? null) !== null);

  useEffect(() => {
    let active = true;
    const check = (): void => {
      restAlertSystemState().then((current) => {
        if (active) setSystem(current);
      }, reportFailure);
    };
    check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  const request = (): void => {
    updateSettings({ restAlertsDeclinedAt: null, restAlertsAskedAt: environment.now() });
    requestRestAlerts().then(setSystem, reportFailure);
  };

  return { permission, declined, request };
}

/** The body is frozen when a rest starts, so adjusting the next set does not reschedule; changing the rest length does. */
export function useRestAlert(request: RestAlertRequest | null): RestAlertPrompt {
  const { permission, declined, request: requestAccess } = useRestAlertAccess();
  const [explaining, setExplaining] = useState(false);

  useEffect(() => cancelRestAlert, []);

  const restId = request?.restId ?? null;
  const endsAt = request?.endsAt ?? null;
  const latestBody = useRef(request?.body ?? "");
  latestBody.current = request?.body ?? "";
  const frozen = useRef<{ readonly restId: string; readonly body: string } | null>(null);
  const resting = restId !== null && endsAt !== null && endsAt > Date.now();

  useEffect(() => {
    if (resting && permission === "ask" && !declined) setExplaining(true);
  }, [resting, permission, declined]);

  useEffect(() => {
    if (restId === null || endsAt === null || endsAt <= Date.now()) {
      cancelRestAlert();
      return;
    }
    if (frozen.current?.restId !== restId) frozen.current = { restId, body: latestBody.current };
    if (permission === "granted") scheduleRestAlert({ endsAt, body: frozen.current.body });
  }, [permission, restId, endsAt]);

  const allow = (): void => {
    setExplaining(false);
    requestAccess();
  };

  const later = (): void => {
    setExplaining(false);
    updateSettings({ restAlertsDeclinedAt: environment.now() });
  };

  return { explaining, allow, later };
}
