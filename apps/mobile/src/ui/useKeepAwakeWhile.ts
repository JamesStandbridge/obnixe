import { useEffect, useId } from "react";
import { activateKeepAwakeAsync, deactivateKeepAwake, isAvailableAsync } from "expo-keep-awake";

function isWakeLockRefusal(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "NotAllowedError";
}

async function keepAwake(tag: string): Promise<boolean> {
  if (!(await isAvailableAsync())) return false;
  try {
    await activateKeepAwakeAsync(tag);
    return true;
  } catch (error) {
    if (isWakeLockRefusal(error)) return false;
    throw error;
  }
}

export function useKeepAwakeWhile(active: boolean): void {
  const tag = useId();
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let activated = false;
    void keepAwake(tag).then((granted) => {
      activated = granted;
      if (granted && cancelled) void deactivateKeepAwake(tag);
    });
    return () => {
      cancelled = true;
      if (activated) void deactivateKeepAwake(tag);
    };
  }, [active, tag]);
}
