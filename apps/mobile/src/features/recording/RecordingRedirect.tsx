import { useEffect, useRef } from "react";
import { router, usePathname } from "expo-router";
import { useRecordingSessionId } from "@/features/tracking/recorder";

/** `REC-081`: a recording found again at launch, running or interrupted, opens its screen once. */
export function RecordingRedirect() {
  const sessionId = useRecordingSessionId();
  const pathname = usePathname();
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current || sessionId === null) return;
    handled.current = true;
    if (!pathname.startsWith("/record")) router.push({ pathname: "/record/[id]", params: { id: sessionId } });
  }, [sessionId, pathname]);
  return null;
}
