import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { settings } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { updateSettings } from "@/data/settings";
import { cancelRestAlert, requestRestAlerts, restAlertPermission, scheduleRestAlert } from "@/features/training/workout/restAlert";
import type { RestAlertPermission } from "@/features/training/workout/restAlert";

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

/** The body is frozen when a rest starts, so adjusting the next set does not reschedule; changing the rest length does. */
export function useRestAlert(request: RestAlertRequest | null): RestAlertPrompt {
  const [permission, setPermission] = useState<RestAlertPermission | null>(null);
  const [explaining, setExplaining] = useState(false);
  const { data: settingsRows } = useLiveQuery(db().select({ declinedAt: settings.restAlertsDeclinedAt }).from(settings));
  const declined = (settingsRows[0]?.declinedAt ?? null) !== null;

  useEffect(() => {
    let active = true;
    const check = (): void => {
      restAlertPermission().then((current) => {
        if (active) setPermission(current);
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
    requestRestAlerts().then(setPermission, reportFailure);
  };

  const later = (): void => {
    setExplaining(false);
    updateSettings({ restAlertsDeclinedAt: environment.now() });
  };

  return { explaining, allow, later };
}
