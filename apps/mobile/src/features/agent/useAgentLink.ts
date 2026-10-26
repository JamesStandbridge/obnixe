import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { closeDanglingConnections } from "@obnixe/core";
import type { ConnectionEndReason } from "@obnixe/schema";
import { db } from "@/data/database";
import { AgentLink } from "@/features/agent/link";
import type { LinkNotice, LinkView } from "@/features/agent/link";
import { useKeepAwakeWhile } from "@/ui/useKeepAwakeWhile";

export interface AgentLinkControls {
  readonly view: LinkView;
  readonly end: (reason: ConnectionEndReason) => void;
  readonly restart: () => void;
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
