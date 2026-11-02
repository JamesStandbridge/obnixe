import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { remoteAccess, useRemoteAccess } from "@/features/remote/access";
import { ApprovalSheet } from "@/features/remote/components";
import { notifyApprovalRequest } from "@/features/remote/notifications";
import { useSnackbar } from "@/ui/SnackbarHost";

/** Serves remote agents for the whole app: reconnects to the relay at launch and asks the user about every authorization. */
export function RemoteAccessHost() {
  const { pending } = useRemoteAccess();
  const notify = useSnackbar();
  const announced = useRef(new Set<string>());
  useEffect(() => {
    remoteAccess.attach();
  }, []);
  useEffect(() => {
    for (const request of pending) {
      if (announced.current.has(request.id)) continue;
      announced.current.add(request.id);
      if (AppState.currentState !== "active") notifyApprovalRequest(request.client);
    }
  }, [pending]);
  return (
    <ApprovalSheet
      request={pending[0] ?? null}
      onDecide={(id, approved) => {
        const client = pending.find((candidate) => candidate.id === id)?.client ?? "L'agent";
        remoteAccess.decide(id, approved);
        notify({ text: approved ? `${client} autorisé, retourne dans l'agent` : `Accès refusé à ${client}`, aboveTabBar: false });
      }}
    />
  );
}
