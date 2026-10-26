import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { activateKeepAwakeAsync, deactivateKeepAwake, isAvailableAsync } from "expo-keep-awake";
import { closeDanglingConnections } from "@obnixe/core";
import type { ConnectionEndReason } from "@obnixe/schema";
import { db } from "@/data/database";
import { AgentLink } from "@/features/agent/link";
import type { LinkNotice, LinkView } from "@/features/agent/link";

const keepAwakeTag = "obnixe-agent";

export interface AgentLinkControls {
  readonly view: LinkView;
  readonly end: (reason: ConnectionEndReason) => void;
  readonly restart: () => void;
}

function isWakeLockRefusal(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "NotAllowedError";
}

async function keepAwake(): Promise<boolean> {
  if (!(await isAvailableAsync())) return false;
  try {
    await activateKeepAwakeAsync(keepAwakeTag);
    return true;
  } catch (error) {
    if (isWakeLockRefusal(error)) return false;
    throw error;
  }
}

function useKeepAwakeWhile(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let activated = false;
    void keepAwake().then((granted) => {
      activated = granted;
      if (granted && cancelled) void deactivateKeepAwake(keepAwakeTag);
    });
    return () => {
      cancelled = true;
      if (activated) void deactivateKeepAwake(keepAwakeTag);
    };
  }, [active]);
}

export function useAgentLink(host: string | null, onNotice: (notice: LinkNotice) => void): AgentLinkControls {
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;
  const linkRef = useRef<AgentLink | null>(null);
  const [view, setView] = useState<LinkView>(() => {
    const link = new AgentLink(host, { onView: (next) => setView(next), onNotice: (notice) => noticeRef.current(notice) });
    linkRef.current = link;
    return link.view;
  });

  useEffect(() => {
    const link = linkRef.current;
    if (link === null) return;
    closeDanglingConnections(db());
    link.start();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") link.suspend();
      if (state === "active") link.resume();
    });
    return () => {
      subscription.remove();
      link.dispose("screen_closed");
    };
  }, []);

  useEffect(() => {
    linkRef.current?.setHost(host);
  }, [host]);

  useKeepAwakeWhile(view.kind !== "disconnected");

  const end = useCallback((reason: ConnectionEndReason) => linkRef.current?.end(reason), []);
  const restart = useCallback(() => linkRef.current?.start(), []);
  return { view, end, restart };
}
