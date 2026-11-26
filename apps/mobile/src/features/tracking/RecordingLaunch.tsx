import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { addDatabaseChangeListener } from "expo-sqlite";
import { write } from "@/data/write";
import { reconcileRecordingFiles } from "@/features/tracking/launchReconciliation";
import { derivedRebuild, recorder, watchBattery, watchWeather, weatherQueue } from "@/features/tracking/recorder";

/** Tables whose changes can make records, segment efforts or masked previews stale. */
const derivedSources: ReadonlySet<string> = new Set(["session", "recording", "lap", "privacy_zone", "settings", "segment"]);
const rebuildDelayMs = 500;

function report(error: unknown): void {
  ErrorUtils.getGlobalHandler()(error, false);
}

/** Weather waits for the derivation, which knows where a saved or imported activity starts. */
async function refreshDerivedAndWeather(): Promise<void> {
  await derivedRebuild.request();
  await weatherQueue.request();
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
 * then keeps the derived rows and the weather of saved activities current and feeds the battery level to the recorder.
 */
export function RecordingLaunch({ children }: RecordingLaunchProps) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    launchRecording()
      .catch(report)
      .finally(() => {
        if (mounted) setReady(true);
        void refreshDerivedAndWeather();
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
        void refreshDerivedAndWeather();
      }, rebuildDelayMs);
    });
    const stopBattery = watchBattery();
    const stopWeather = watchWeather();
    return () => {
      changes.remove();
      stopBattery();
      stopWeather();
      if (timer !== null) clearTimeout(timer);
    };
  }, [ready]);

  return ready ? children : null;
}
