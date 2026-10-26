import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { closeDanglingConnections } from "@obnixe/core";
import type { PairingInvite } from "@obnixe/core";
import type { ConnectionEndReason } from "@obnixe/schema";
import { db } from "@/data/database";
import { AgentLink } from "@/features/agent/link";
import type { LinkNotice, LinkView } from "@/features/agent/link";
import { useKeepAwakeWhile } from "@/ui/useKeepAwakeWhile";

export interface AgentLinkControls {
  readonly view: LinkView;
  readonly knownMac: string | null;
  readonly end: (reason: ConnectionEndReason) => void;
  readonly restart: () => void;
  readonly forget: () => void;
  readonly join: (invite: PairingInvite) => void;
  readonly cancelJoin: () => void;
}

export function useAgentLink(host: string | null, onNotice: (notice: LinkNotice) => void): AgentLinkControls {
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;
  const linkRef = useRef<AgentLink | null>(null);
  const [view, setView] = useState<LinkView>(() => {
    const link = new AgentLink(host, { onView: (next) => setView(next), onNotice: (notice) => noticeRef.current(notice), onKnownMac: (mac) => setKnownMac(mac) });
    linkRef.current = link;
    return link.view;
  });
  const [knownMac, setKnownMac] = useState<string | null>(() => linkRef.current?.knownMac ?? null);

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
  const forget = useCallback(() => linkRef.current?.forget(), []);
  const join = useCallback((invite: PairingInvite) => linkRef.current?.join(invite), []);
  const cancelJoin = useCallback(() => linkRef.current?.cancelJoin(), []);
  return { view, knownMac, end, restart, forget, join, cancelJoin };
}
