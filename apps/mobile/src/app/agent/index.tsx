import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { callTag, changeCount, connectionRecap, revertState } from "@obnixe/core";
import type { RevertIndex } from "@obnixe/core";
import type { EpochMs, Id } from "@obnixe/schema";
import { environment } from "@/data/database";
import { deviceTimeZone, formatTimeAt } from "@/format/dates";
import { plural } from "@/format/labels";
import {
  ActivityRow,
  AgentAppBar,
  AgentPermissions,
  BottomAction,
  CodePanel,
  ForgetMac,
  ForgetMacSheet,
  Heading,
  HistoryLink,
  HostSheet,
  NetworkLine,
  PairingSteps,
  ResumePanel,
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
import { goBack } from "@/ui/navigation";

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

interface ResumingProps {
  readonly view: Extract<LinkView, { kind: "resuming" }>;
  readonly settings: AgentSettings;
  readonly onEditHost: () => void;
  readonly onForget: () => void;
}

function Resuming({ view, settings, onEditHost, onForget }: ResumingProps) {
  const photoCount = usePhotoCount();
  return (
    <>
      <ResumePanel mac={view.mac} network={view.network} />
      <NetworkLine network={view.network} host={settings.bridgeHost} onPress={onEditHost} />
      <AgentPermissions settings={settings} connected={false} photoCount={photoCount} onChange={setPermission} />
      <HistoryLink detail="connexions précédentes" onPress={openLog} />
      <ForgetMac mac={view.mac} onPress={onForget} />
    </>
  );
}

interface ConnectedProps {
  readonly connectionId: Id;
  readonly settings: AgentSettings;
  readonly knownMac: string | null;
  readonly onForget: () => void;
}

function Connected({ connectionId, settings, knownMac, onForget }: ConnectedProps) {
  const connection = useConnection(connectionId);
  const calls = useCalls(connectionId);
  const index = useRevertIndex();
  const photoCount = usePhotoCount();
  const toggle = useToggleChange(bottomPanelHeight);
  if (connection === null) return null;
  return (
    <>
      <StatusPanel title={`${connection.client} · ${connection.host}`} since={formatTimeAt(connection.startedAt, deviceTimeZone())} />
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
                time={formatTimeAt(call.calledAt, deviceTimeZone())}
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
      {knownMac === null ? null : <ForgetMac mac={knownMac} onPress={onForget} />}
    </>
  );
}

interface DisconnectedProps {
  readonly connectionId: Id;
  readonly at: EpochMs;
  readonly knownMac: string | null;
  readonly onForget: () => void;
}

function Disconnected({ connectionId, at, knownMac, onForget }: DisconnectedProps) {
  const connection = useConnection(connectionId);
  const calls = useCalls(connectionId);
  const endedAt = connection?.endedAt ?? at;
  const reads = calls.filter((call) => call.kind === "read").length;
  const writes = calls.length - reads;
  return (
    <>
      <Heading eyebrow={`Connexion coupée à ${formatTimeAt(endedAt, deviceTimeZone())}`} title="Plus aucun accès réseau" />
      {connection === null ? null : (
        <Text tone="secondary" style={styles.summary}>
          {connectionRecap(connection.client, reads, writes, endedAt - connection.startedAt)}
        </Text>
      )}
      <HistoryLink detail="cette connexion et les précédentes" onPress={openLog} />
      {knownMac === null ? null : <ForgetMac mac={knownMac} onPress={onForget} />}
    </>
  );
}

function noticeText(notice: LinkNotice): string {
  switch (notice) {
    case "code_refused":
      return "Code refusé trop de fois, nouveau code";
    case "version":
      return "Mets à jour obnixe-bridge sur le Mac";
    case "forgotten":
      return "Le Mac ne reconnaît plus ce téléphone, saisis le nouveau code";
    default: {
      const unreachable: never = notice;
      return unreachable;
    }
  }
}

function bottomLabel(view: LinkView, knownMac: string | null): string {
  switch (view.kind) {
    case "pairing":
      return "Annuler l'appairage";
    case "resuming":
      return "Annuler la reconnexion";
    case "connected":
      return "Couper la connexion";
    case "disconnected":
      return knownMac === null ? "Générer un nouveau code" : "Reconnecter";
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
  const [forgetting, setForgetting] = useState(false);
  const [sheetMac, setSheetMac] = useState("");
  const onNotice = useCallback(
    (notice: LinkNotice) => {
      notify({ text: noticeText(notice), aboveTabBar: false, extraOffset: bottomPanelHeight });
    },
    [notify],
  );
  const { view, knownMac, end, restart, forget } = useAgentLink(settings.bridgeHost, onNotice);
  const askForget = (): void => {
    if (knownMac === null) return;
    setSheetMac(knownMac);
    setForgetting(true);
  };

  const bottomAction = (): void => {
    switch (view.kind) {
      case "pairing":
      case "resuming":
        goBack("/");
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
        <AgentAppBar onBack={() => goBack("/")} />
        {view.kind === "pairing" ? <Pairing view={view} settings={settings} onEditHost={() => setEditingHost(true)} /> : null}
        {view.kind === "resuming" ? <Resuming view={view} settings={settings} onEditHost={() => setEditingHost(true)} onForget={askForget} /> : null}
        {view.kind === "connected" ? <Connected connectionId={view.connectionId} settings={settings} knownMac={knownMac} onForget={askForget} /> : null}
        {view.kind === "disconnected" ? <Disconnected connectionId={view.connectionId} at={view.at} knownMac={knownMac} onForget={askForget} /> : null}
      </Screen>
      <BottomAction label={bottomLabel(view, knownMac)} onPress={bottomAction} />
      <ForgetMacSheet
        open={forgetting}
        mac={sheetMac}
        onClose={() => setForgetting(false)}
        onConfirm={() => {
          setForgetting(false);
          forget();
        }}
      />
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
