import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { addDatabaseChangeListener } from "expo-sqlite";
import { write } from "@/data/write";
import { reconcileRecordingFiles } from "@/features/tracking/launchReconciliation";
import { derivedRebuild, recorder, watchBattery } from "@/features/tracking/recorder";

/** Tables whose changes can make records or masked previews stale. */
const derivedSources: ReadonlySet<string> = new Set(["session", "recording", "lap", "privacy_zone", "settings"]);
const rebuildDelayMs = 500;

function report(error: unknown): void {
  ErrorUtils.getGlobalHandler()(error, false);
}

async function launchRecording(): Promise<void> {
  await reconcileRecordingFiles({ write }).catch(report);
  await recorder.recover();
}

interface RecordingLaunchProps {
  readonly children: ReactNode;
}

/**
 * Holds the app until track files and journals are reconciled and an open recording is recovered (annex C, `REC-081`),
 * then keeps the derived rows current and feeds the battery level to the recorder.
 */
export function RecordingLaunch({ children }: RecordingLaunchProps) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    launchRecording()
      .catch(report)
      .finally(() => {
        if (mounted) setReady(true);
        void derivedRebuild.request();
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const changes = addDatabaseChangeListener((event) => {
      if (!derivedSources.has(event.tableName) || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void derivedRebuild.request();
      }, rebuildDelayMs);
    });
    const stopBattery = watchBattery();
    return () => {
      changes.remove();
      stopBattery();
      if (timer !== null) clearTimeout(timer);
    };
  }, [ready]);

  return ready ? children : null;
}
