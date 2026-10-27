import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { callTag, changeCount, connectionRecap, revertState } from "@obnixe/core";
import type { PairingInvite, RevertIndex } from "@obnixe/core";
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
  InviteSheet,
  JoinPanel,
  ManualToggle,
  NetworkLine,
  PairingSteps,
  ResumePanel,
  ScanIntro,
  StatusPanel,
  bottomPanelHeight,
} from "@/features/agent/components";
import { inviteProblemText, usePairingRequests } from "@/features/agent/invites";
import type { PairingRequest } from "@/features/agent/invites";
import type { LinkNotice, LinkView } from "@/features/agent/link";
import { saveBridgeHost, setPermission, useAgentSettings, useAgentTotals, useCalls, useConnection, usePhotoCount, useRevertIndex } from "@/features/agent/queries";
import type { AgentSettings, CallRow } from "@/features/agent/queries";
import { useAgentLink } from "@/features/agent/useAgentLink";
import { useToggleChange } from "@/features/agent/useToggleChange";
import { LinkButton } from "@/ui/Button";
import { Section, Screen } from "@/ui/Layout";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";
import { goBack } from "@/ui/navigation";

function openLog(): void {
  router.push("/agent/log");
}

function openScanner(): void {
  router.push("/agent/scan");
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
  readonly manual: boolean;
  readonly onToggleManual: () => void;
  readonly onEditHost: () => void;
}

function Pairing({ view, settings, manual, onToggleManual, onEditHost }: PairingProps) {
  const remaining = useSecondsUntil(manual ? view.expiresAt : null);
  const totals = useAgentTotals();
  const photoCount = usePhotoCount();
  const detail = totals.connections === 0 ? "Aucune connexion pour l'instant" : `${plural(totals.connections, "connexion", "connexions")} · ${changeCount(totals.writes)}`;
  return (
    <>
      <Heading title="Relie Cursor à ton suivi" />
      <ScanIntro onScan={openScanner} />
      <ManualToggle open={manual} onPress={onToggleManual} />
      {manual ? (
        <>
          <NetworkLine network={view.network} host={view.host} onPress={onEditHost} />
          {view.host === null ? null : (
            <>
              <CodePanel code={view.code} remainingSeconds={remaining} />
              <PairingSteps code={view.code} />
            </>
          )}
        </>
      ) : null}
      <AgentPermissions settings={settings} connected={false} photoCount={photoCount} onChange={setPermission} />
      <HistoryLink detail={detail} onPress={openLog} />
    </>
  );
}

interface JoiningProps {
  readonly view: Extract<LinkView, { kind: "joining" }>;
  readonly settings: AgentSettings;
  readonly onEditHost: () => void;
}

function Joining({ view, settings, onEditHost }: JoiningProps) {
  const photoCount = usePhotoCount();
  return (
    <>
      <JoinPanel mac={view.mac} network={view.network} host={view.host} />
      {view.network === "unreachable" ? <NetworkLine network={view.network} host={view.host} onPress={onEditHost} /> : null}
      <AgentPermissions settings={settings} connected={false} photoCount={photoCount} onChange={setPermission} />
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
      <NetworkLine network={view.network} host={view.host} onPress={onEditHost} />
      {view.network === "unreachable" ? <LinkButton label="Scanner le QR code du Mac" onPress={openScanner} style={styles.rescan} /> : null}
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
      return "Le Mac ne reconnaît plus ce téléphone, scanne un nouveau QR code";
    case "invite_refused":
      return "QR code déjà utilisé ou remplacé, relance obnixe-bridge pair";
    case "invite_expired":
      return "QR code expiré, relance obnixe-bridge pair sur le Mac";
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
    case "joining":
      return "Annuler";
    case "resuming":
      return "Annuler la reconnexion";
    case "connected":
      return "Couper la connexion";
    case "disconnected":
      return knownMac === null ? "Relier un Mac" : "Reconnecter";
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
  const [manual, setManual] = useState(settings.bridgeHost !== null);
  const [sheetMac, setSheetMac] = useState("");
  const say = useCallback(
    (text: string) => {
      notify({ text, aboveTabBar: false, extraOffset: bottomPanelHeight });
    },
    [notify],
  );
  const onNotice = useCallback((notice: LinkNotice) => say(noticeText(notice)), [say]);
  const { view, knownMac, knownBridgeId, end, restart, forget, join, cancelJoin } = useAgentLink(settings.bridgeHost, onNotice);
  const [confirming, setConfirming] = useState<PairingInvite | null>(null);
  usePairingRequests((request: PairingRequest) => {
    switch (request.kind) {
      case "invite":
        if (request.invite.bridgeId === knownBridgeId) say(`Déjà relié à ${request.invite.name}`);
        else setConfirming(request.invite);
        return;
      case "invalid":
        say(inviteProblemText(request.reason));
        return;
      case "manual":
        setManual(true);
        return;
      default: {
        const unreachable: never = request;
        throw new Error(`Unhandled pairing request ${JSON.stringify(unreachable)}`);
      }
    }
  });
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
      case "joining":
        cancelJoin();
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
        {view.kind === "pairing" ? (
          <Pairing view={view} settings={settings} manual={manual} onToggleManual={() => setManual((open) => !open)} onEditHost={() => setEditingHost(true)} />
        ) : null}
        {view.kind === "joining" ? <Joining view={view} settings={settings} onEditHost={() => setEditingHost(true)} /> : null}
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
      <InviteSheet
        invite={confirming}
        replacing={knownMac}
        onClose={() => setConfirming(null)}
        onConfirm={(invite) => {
          setConfirming(null);
          join(invite);
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
  rescan: { alignSelf: "flex-start", marginLeft: -10 },
});
