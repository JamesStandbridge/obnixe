import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { callTag, changeCount, clockTime, connectionRecap, plural, revertState } from "@obnixe/core";
import type { RevertIndex } from "@obnixe/core";
import type { Id } from "@obnixe/schema";
import { environment } from "@/data/database";
import {
  ActivityRow,
  AgentAppBar,
  AgentPermissions,
  BottomAction,
  CodePanel,
  Heading,
  HistoryLink,
  HostSheet,
  NetworkLine,
  PairingSteps,
  StatusPanel,
  bottomPanelHeight,
} from "@/features/agent/components";
import type { LinkNotice, LinkView } from "@/features/agent/link";
import { saveBridgeHost, setPermission, useAgentSettings, useAgentTotals, useCalls, useConnection, usePhotoCount, useRevertIndex } from "@/features/agent/queries";
import type { AgentSettings, CallRow } from "@/features/agent/queries";
import { useAgentLink } from "@/features/agent/useAgentLink";
import { useToggleChange } from "@/features/agent/useToggleChange";
import { Section, Screen } from "@/ui/Layout";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";

function goBack(): void {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

function openLog(): void {
  router.push("/agent/log");
}

function useSecondsUntil(deadline: number | null): number {
  const [now, setNow] = useState(environment.now());
  useEffect(() => {
    if (deadline === null) return;
    setNow(environment.now());
    const timer = setInterval(() => setNow(environment.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline === null ? 0 : Math.max(0, Math.ceil((deadline - now) / 1000));
}

function activeWrites(calls: readonly CallRow[], index: RevertIndex): number {
  return calls.filter((call) => call.changesetId !== null && !revertState(index, call.changesetId).reverted).length;
}

interface PairingProps {
  readonly view: Extract<LinkView, { kind: "pairing" }>;
  readonly settings: AgentSettings;
  readonly onEditHost: () => void;
}

function Pairing({ view, settings, onEditHost }: PairingProps) {
  const remaining = useSecondsUntil(view.expiresAt);
  const totals = useAgentTotals();
  const photoCount = usePhotoCount();
  const detail = totals.connections === 0 ? "Aucune connexion pour l'instant" : `${plural(totals.connections, "connexion", "connexions")} · ${changeCount(totals.writes)}`;
  return (
    <>
      <Heading title="Relie Cursor à ton suivi" />
      <CodePanel code={view.code} remainingSeconds={remaining} />
      <PairingSteps />
      <NetworkLine network={view.network} host={settings.bridgeHost} onPress={onEditHost} />
      <AgentPermissions settings={settings} connected={false} photoCount={photoCount} onChange={setPermission} />
      <HistoryLink detail={detail} onPress={openLog} />
    </>
  );
}

interface ConnectedProps {
  readonly connectionId: Id;
  readonly settings: AgentSettings;
}

function Connected({ connectionId, settings }: ConnectedProps) {
  const connection = useConnection(connectionId);
  const calls = useCalls(connectionId);
  const index = useRevertIndex();
  const photoCount = usePhotoCount();
  const toggle = useToggleChange(bottomPanelHeight);
  if (connection === null) return null;
  return (
    <>
      <StatusPanel title={`${connection.client} · ${connection.host}`} since={clockTime(connection.startedAt)} />
      <Section
        title="Activité"
        action={
          <Text variant="small" tone="secondary">
            {changeCount(activeWrites(calls, index))}
          </Text>
        }
      >
        {calls.length === 0 ? (
          <Text variant="small" tone="secondary" style={styles.empty}>
            Rien pour l'instant
          </Text>
        ) : (
          calls.map((call, position) => {
            const changesetId = call.changesetId;
            const reverted = changesetId !== null && revertState(index, changesetId).reverted;
            return (
              <ActivityRow
                key={call.id}
                time={clockTime(call.calledAt)}
                tag={callTag(call)}
                title={call.summary}
                tool={call.tool}
                reverted={reverted}
                onToggle={changesetId === null ? null : () => toggle({ changesetId, summary: call.summary })}
                last={position === calls.length - 1}
              />
            );
          })
        )}
      </Section>
      <AgentPermissions settings={settings} connected photoCount={photoCount} onChange={setPermission} />
    </>
  );
}

interface DisconnectedProps {
  readonly connectionId: Id;
  readonly at: number;
}

function Disconnected({ connectionId, at }: DisconnectedProps) {
  const connection = useConnection(connectionId);
  const calls = useCalls(connectionId);
  const endedAt = connection?.endedAt ?? at;
  const reads = calls.filter((call) => call.kind === "read").length;
  const writes = calls.length - reads;
  return (
    <>
      <Heading eyebrow={`Connexion coupée à ${clockTime(endedAt)}`} title="Plus aucun accès réseau" />
      {connection === null ? null : (
        <Text tone="secondary" style={styles.summary}>
          {connectionRecap(connection.client, reads, writes, endedAt - connection.startedAt)}
        </Text>
      )}
      <HistoryLink detail="cette connexion et les précédentes" onPress={openLog} />
    </>
  );
}

function bottomLabel(view: LinkView): string {
  switch (view.kind) {
    case "pairing":
      return "Annuler l'appairage";
    case "connected":
      return "Couper la connexion";
    case "disconnected":
      return "Générer un nouveau code";
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }
}

export default function Agent() {
  const settings = useAgentSettings();
  const notify = useSnackbar();
  const [editingHost, setEditingHost] = useState(false);
  const onNotice = useCallback(
    (notice: LinkNotice) => {
      const text = notice === "code_refused" ? "Code refusé trop de fois, nouveau code" : "Mets à jour obnixe-bridge sur le Mac";
      notify({ text, aboveTabBar: false, extraOffset: bottomPanelHeight });
    },
    [notify],
  );
  const { view, end, restart } = useAgentLink(settings.bridgeHost, onNotice);

  const bottomAction = (): void => {
    switch (view.kind) {
      case "pairing":
        goBack();
        return;
      case "connected":
        end("user");
        return;
      case "disconnected":
        restart();
        return;
      default: {
        const unreachable: never = view;
        throw new Error(`Unhandled view ${JSON.stringify(unreachable)}`);
      }
    }
  };

  return (
    <View style={styles.root}>
      <Screen bottomInset={120}>
        <AgentAppBar onBack={goBack} />
        {view.kind === "pairing" ? <Pairing view={view} settings={settings} onEditHost={() => setEditingHost(true)} /> : null}
        {view.kind === "connected" ? <Connected connectionId={view.connectionId} settings={settings} /> : null}
        {view.kind === "disconnected" ? <Disconnected connectionId={view.connectionId} at={view.at} /> : null}
      </Screen>
      <BottomAction label={bottomLabel(view)} onPress={bottomAction} />
      <HostSheet
        open={editingHost}
        host={settings.bridgeHost}
        onClose={() => setEditingHost(false)}
        onSave={(host) => {
          saveBridgeHost(host);
          setEditingHost(false);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  summary: { marginTop: 8, lineHeight: 23 },
  empty: { paddingVertical: 14 },
});
