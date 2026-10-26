import { useEffect, useState } from "react";
import { cancelRestAlert, requestRestAlerts, restAlertPermission, scheduleRestAlert } from "@/features/training/workout/restAlert";
import type { RestAlert, RestAlertPermission } from "@/features/training/workout/restAlert";

export interface RestAlertPrompt {
  readonly explaining: boolean;
  readonly allow: () => void;
  readonly later: () => void;
}

let postponedThisRun = false;

/** Schedules the end-of-rest notification while `alert` stays the same; any change or unmount cancels it. */
export function useRestAlert(alert: RestAlert | null): RestAlertPrompt {
  const [permission, setPermission] = useState<RestAlertPermission | null>(null);
  const [explaining, setExplaining] = useState(false);

  useEffect(() => {
    let active = true;
    void restAlertPermission().then((current) => {
      if (active) setPermission(current);
    });
    return () => {
      active = false;
    };
  }, []);

  const resting = alert !== null && alert.endsAt > Date.now();
  useEffect(() => {
    if (resting && permission === "ask" && !postponedThisRun) setExplaining(true);
  }, [resting, permission]);

  const endsAt = alert?.endsAt ?? null;
  const body = alert?.body ?? "";
  useEffect(() => {
    if (permission !== "granted" || endsAt === null || endsAt <= Date.now()) return;
    let cancelled = false;
    let scheduledId: string | null = null;
    void scheduleRestAlert({ endsAt, body }).then((id) => {
      if (cancelled) void cancelRestAlert(id);
      else scheduledId = id;
    });
    return () => {
      cancelled = true;
      if (scheduledId !== null) void cancelRestAlert(scheduledId);
    };
  }, [permission, endsAt, body]);

  const allow = (): void => {
    setExplaining(false);
    void requestRestAlerts().then(setPermission);
  };

  const later = (): void => {
    postponedThisRun = true;
    setExplaining(false);
  };

  return { explaining, allow, later };
}
