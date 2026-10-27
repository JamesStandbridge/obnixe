import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CallTag, PairingInvite } from "@obnixe/core";
import { ControlButton, PrimaryButton, SheetButton } from "@/ui/Button";
import { Switch } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import { IconButton, TextField } from "@/ui/Inputs";
import { Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";
import { isTailscaleHost, normalizeHost } from "@/features/agent/host";
import type { NetworkState } from "@/features/agent/link";
import type { AgentSettings, PermissionKey } from "@/features/agent/queries";
import { formatClock } from "@/format/durations";

export const bottomPanelHeight = 71;

const monospace = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, SFMono-Regular, Menlo, monospace" });

interface AgentAppBarProps {
  readonly onBack: () => void;
}

export function AgentAppBar({ onBack }: AgentAppBarProps) {
  return (
    <View style={styles.appbar}>
      <IconButton icon="back" label="Retour" edge="start" onPress={onBack} />
      <Text variant="label" tone="secondary" style={styles.appbarContext}>
        Agent
      </Text>
    </View>
  );
}

interface HeadingProps {
  readonly title: string;
  readonly eyebrow?: string;
}

export function Heading({ title, eyebrow }: HeadingProps) {
  return (
    <View style={styles.head}>
      {eyebrow === undefined ? null : (
        <Text variant="eyebrow" tone="secondary">
          {eyebrow}
        </Text>
      )}
      <Text accessibilityRole="header" style={styles.headTitle}>
        {title}
      </Text>
    </View>
  );
}

interface HistoryLinkProps {
  readonly detail: string;
  readonly onPress: () => void;
}

export function HistoryLink({ detail, onPress }: HistoryLinkProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Activité des agents, ${detail}`}
      onPress={onPress}
      style={({ pressed }) => [styles.historyLink, { borderTopColor: colors.line }, pressed && { backgroundColor: colors.surface }]}
    >
      <View style={styles.rowMain}>
        <Text variant="bodyStrong">Activité des agents</Text>
        <Text variant="small" tone="secondary">
          {detail}
        </Text>
      </View>
      <Icon name="chevron" size={16} color={colors.text3} />
    </Pressable>
  );
}

interface BottomActionProps {
  readonly label: string;
  readonly onPress: () => void;
}

export function BottomAction({ label, onPress }: BottomActionProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bottomPanel, { backgroundColor: colors.bg, borderTopColor: colors.line, paddingBottom: insets.bottom + 12 }]}>
      <ControlButton label={label} onPress={onPress} />
    </View>
  );
}

interface CodePanelProps {
  readonly code: string;
  readonly remainingSeconds: number;
}

export function CodePanel({ code, remainingSeconds }: CodePanelProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.code, { backgroundColor: colors.surface }]}>
      <View accessible accessibilityRole="text" accessibilityLabel={`Code ${code.split("").join(" ")}`} style={styles.codeDigits}>
        <Text style={styles.codeGroup} maxFontSizeMultiplier={1}>
          {code.slice(0, 3)}
        </Text>
        <Text style={styles.codeGroup} maxFontSizeMultiplier={1}>
          {code.slice(3)}
        </Text>
      </View>
      <Text tone="secondary" style={styles.expiry} accessibilityLiveRegion="none">
        Expire dans <Text style={styles.expiryClock}>{formatClock(remainingSeconds)}</Text>
      </Text>
    </View>
  );
}

interface ScanIntroProps {
  readonly onScan: () => void;
}

export function ScanIntro({ onScan }: ScanIntroProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.scan}>
      <Text tone="secondary" style={styles.scanText}>
        Sur le Mac, lance <Text style={[styles.command, { backgroundColor: colors.surface }]}>obnixe-bridge pair</Text> : un QR code s'affiche. Le téléphone s'y relie sans rien saisir.
      </Text>
      <PrimaryButton label="Scanner le QR code du Mac" onPress={onScan} />
    </View>
  );
}

interface ManualToggleProps {
  readonly open: boolean;
  readonly onPress: () => void;
}

export function ManualToggle({ open, onPress }: ManualToggleProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel="Saisir l'adresse, sans caméra, avec un code"
      onPress={onPress}
      style={({ pressed }) => [styles.manual, { borderTopColor: colors.line }, pressed && { backgroundColor: colors.surface }]}
    >
      <View style={styles.rowMain}>
        <Text variant="bodyStrong">Saisir l'adresse</Text>
        <Text variant="small" tone="secondary">
          sans caméra, avec un code à 6 chiffres
        </Text>
      </View>
      <Icon name={open ? "collapse" : "expand"} size={16} color={colors.text3} />
    </Pressable>
  );
}

interface PairingStepsProps {
  readonly code: string;
}

export function PairingSteps({ code }: PairingStepsProps) {
  const { colors } = useTheme();
  const steps: readonly ReactNode[] = [
    <>
      Sur le Mac, lance <Text style={[styles.command, { backgroundColor: colors.surface }]}>obnixe-bridge pair {code}</Text>
    </>,
    "Garde cet écran ouvert pendant la connexion",
  ];
  return (
    <View style={styles.steps} accessibilityRole="list">
      {steps.map((step, index) => (
        <View key={index} style={[styles.step, { borderBottomColor: colors.line, borderBottomWidth: index === steps.length - 1 ? 0 : 1 }]}>
          <Text tone="tertiary" style={styles.stepNumber}>
            {index + 1}
          </Text>
          <Text style={styles.stepText}>{step}</Text>
        </View>
      ))}
    </View>
  );
}

interface DotProps {
  readonly network: NetworkState | "connected";
}

export function Dot({ network }: DotProps) {
  const { colors } = useTheme();
  switch (network) {
    case "reachable":
    case "connected":
      return <View style={[styles.dot, { backgroundColor: colors.mark }]} />;
    case "unreachable":
      return <View style={[styles.dot, styles.dotRing, { borderColor: colors.warn }]} />;
    case "dialing":
    case "idle":
      return <View style={[styles.dot, styles.dotRing, { borderColor: colors.text3 }]} />;
    default: {
      const unreachable: never = network;
      return unreachable;
    }
  }
}

function networkLabel(network: NetworkState, host: string | null): string {
  if (host === null) return "Indique l'adresse IP du Mac";
  switch (network) {
    case "reachable":
      return `${isTailscaleHost(host) ? "Tailscale actif" : "Mac joignable"} · ${host}`;
    case "unreachable":
      return `Mac injoignable · ${host}`;
    case "dialing":
    case "idle":
      return `Recherche du Mac · ${host}`;
    default: {
      const unreachable: never = network;
      return unreachable;
    }
  }
}

interface NetworkLineProps {
  readonly network: NetworkState;
  readonly host: string | null;
  readonly onPress: () => void;
}

export function NetworkLine({ network, host, onPress }: NetworkLineProps) {
  const { colors } = useTheme();
  const label = networkLabel(network, host);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={host === null ? label : `${label}. Modifier l'adresse du Mac`}
      onPress={onPress}
      style={({ pressed }) => [styles.network, pressed && { backgroundColor: colors.surface }]}
    >
      <Dot network={host === null ? "idle" : network} />
      <Text variant="small" tone="secondary" style={[styles.networkText, host === null && styles.networkPrompt, host === null && { color: colors.text }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

interface PermissionRowProps {
  readonly label: string;
  readonly detail?: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly last?: boolean;
}

function PermissionRow({ label, detail, value, onChange, last = false }: PermissionRowProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={detail === undefined ? label : `${label}, ${detail}`}
      aria-checked={value}
      onPress={() => onChange(!value)}
      style={({ pressed }) => [styles.permission, { borderBottomColor: colors.line, borderBottomWidth: last ? 0 : 1 }, pressed && { backgroundColor: colors.surface }]}
    >
      <View style={styles.permissionText}>
        <Text variant="bodyStrong">{label}</Text>
        {detail === undefined ? null : (
          <Text variant="small" tone="secondary">
            {detail}
          </Text>
        )}
      </View>
      <View pointerEvents="none" aria-hidden>
        <Switch value={value} onChange={onChange} label={label} />
      </View>
    </Pressable>
  );
}

interface AgentPermissionsProps {
  readonly settings: AgentSettings;
  readonly connected: boolean;
  readonly photoCount: number;
  readonly onChange: (key: PermissionKey, value: boolean) => void;
}

export function AgentPermissions({ settings, connected, photoCount, onChange }: AgentPermissionsProps) {
  const { colors } = useTheme();
  const photoDetail = connected && photoCount > 0 ? `${photoCount} photo${photoCount > 1 ? "s" : ""}` : undefined;
  return (
    <Section title="Autorisations">
      {connected ? null : (
        <View style={[styles.permission, { borderBottomColor: colors.line, borderBottomWidth: 1 }]} accessible accessibilityLabel="Lire séances et programmes, toujours autorisé">
          <View style={styles.permissionText}>
            <Text variant="bodyStrong">Lire séances et programmes</Text>
          </View>
          <Text tone="secondary" style={styles.plainTag}>
            Toujours
          </Text>
        </View>
      )}
      <PermissionRow label="Lire le corps" detail="poids et mensurations, lecture et saisie" value={settings.canReadBody} onChange={(value) => onChange("agentCanReadBody", value)} />
      <PermissionRow
        label="Modifier directement"
        {...(connected ? {} : { detail: "toujours réversible" })}
        value={settings.canWrite}
        onChange={(value) => onChange("agentCanWrite", value)}
      />
      <PermissionRow label="Voir les photos" {...(photoDetail === undefined ? {} : { detail: photoDetail })} value={settings.canReadPhotos} onChange={(value) => onChange("agentCanReadPhotos", value)} last />
    </Section>
  );
}

interface CallTagLabelProps {
  readonly tag: CallTag;
}

export function CallTagLabel({ tag }: CallTagLabelProps) {
  const { colors } = useTheme();
  if (tag === "Lecture") {
    return (
      <Text tone="secondary" style={[styles.plainTag, styles.tagStart]}>
        {tag}
      </Text>
    );
  }
  return (
    <View style={[styles.tag, { borderColor: colors.controlBorder }]}>
      <Text style={styles.tagLabel}>{tag}</Text>
    </View>
  );
}

interface ActivityRowProps {
  readonly time: string;
  readonly tag: CallTag | null;
  readonly title: string;
  readonly tool: string | null;
  readonly reverted: boolean;
  readonly onToggle: (() => void) | null;
  readonly wide?: boolean;
  readonly last?: boolean;
}

export function ActivityRow({ time, tag, title, tool, reverted, onToggle, wide = false, last = false }: ActivityRowProps) {
  const { colors } = useTheme();
  const verb = tag === "Ajout" ? "l'ajout" : "la modification";
  return (
    <View style={[styles.activity, wide && styles.activityWide, { borderBottomColor: colors.line, borderBottomWidth: last ? 0 : 1 }]}>
      <Text tone="secondary" style={[styles.time, wide && styles.timeWide]}>
        {time}
      </Text>
      <View style={[styles.activityMain, wide && styles.activityMainWide]}>
        {tag === null ? null : <CallTagLabel tag={tag} />}
        <Text
          variant="bodyStrong"
          tone={reverted ? "secondary" : "primary"}
          style={[styles.activityTitle, reverted && styles.reverted]}
          accessibilityLabel={reverted ? `${title}, annulée` : title}
        >
          {title}
        </Text>
        {tool === null ? null : <Text style={[styles.tool, { color: colors.text3 }]}>{tool}</Text>}
      </View>
      {onToggle === null ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${reverted ? "Rétablir" : "Annuler"} ${verb} de ${time}`}
          onPress={onToggle}
          style={({ pressed }) => [styles.activityAction, pressed && { backgroundColor: colors.surface }]}
        >
          <Text variant="label" style={styles.linkLabel}>
            {reverted ? "Rétablir" : "Revenir"}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

interface StatusPanelProps {
  readonly title: string;
  readonly since: string;
}

export function StatusPanel({ title, since }: StatusPanelProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.status, { backgroundColor: colors.surface, borderLeftColor: colors.mark }]} accessible accessibilityLabel={`Connecté, ${title}, depuis ${since}`}>
      <View style={styles.statusHeader}>
        <Dot network="connected" />
        <Text style={styles.statusEyebrow}>Connecté</Text>
      </View>
      <Text style={styles.statusTitle}>{title}</Text>
      <Text variant="small" tone="secondary">
        Depuis {since}
      </Text>
    </View>
  );
}

interface ResumePanelProps {
  readonly mac: string;
  readonly network: NetworkState;
}

interface JoinPanelProps {
  readonly mac: string;
  readonly network: NetworkState;
  readonly host: string | null;
}

export function JoinPanel({ mac, network, host }: JoinPanelProps) {
  const { colors } = useTheme();
  const lost = network === "unreachable";
  return (
    <View
      style={[styles.status, { backgroundColor: colors.surface, borderLeftColor: lost ? colors.warn : colors.text3 }]}
      accessible
      accessibilityLabel={lost ? `${mac} introuvable` : `Connexion à ${mac}`}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.statusHeader}>
        <Dot network={network} />
        <Text style={styles.statusEyebrow}>{lost ? "Mac introuvable" : "Appairage…"}</Text>
      </View>
      <Text style={styles.statusTitle}>{mac}</Text>
      <Text variant="small" tone="secondary">
        {lost ? "Mets le téléphone sur le même Wi-Fi que le Mac, ou active Tailscale. Nouvel essai dans un instant." : host === null ? "QR code lu" : `QR code lu, essai de ${host}`}
      </Text>
    </View>
  );
}

export function ResumePanel({ mac, network }: ResumePanelProps) {
  const { colors } = useTheme();
  return (
    <View
      style={[styles.status, { backgroundColor: colors.surface, borderLeftColor: network === "unreachable" ? colors.warn : colors.text3 }]}
      accessible
      accessibilityLabel={`Reconnexion à ${mac}`}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.statusHeader}>
        <Dot network={network} />
        <Text style={styles.statusEyebrow}>Reconnexion…</Text>
      </View>
      <Text style={styles.statusTitle}>{mac}</Text>
      <Text variant="small" tone="secondary">
        Mac déjà appairé, pas de code à saisir
      </Text>
    </View>
  );
}

interface ForgetMacProps {
  readonly mac: string;
  readonly onPress: () => void;
}

export function ForgetMac({ mac, onPress }: ForgetMacProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Oublier ce Mac, ${mac}`}
      onPress={onPress}
      style={({ pressed }) => [styles.forget, { borderTopColor: colors.line }, pressed && { backgroundColor: colors.surface }]}
    >
      <View style={styles.rowMain}>
        <Text variant="bodyStrong">Oublier ce Mac</Text>
        <Text variant="small" tone="secondary">
          il faudra scanner un nouveau QR code
        </Text>
      </View>
    </Pressable>
  );
}

interface ForgetMacSheetProps {
  readonly open: boolean;
  readonly mac: string;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}

export function ForgetMacSheet({ open, mac, onClose, onConfirm }: ForgetMacSheetProps) {
  return (
    <Sheet open={open} title={`Oublier ${mac} ?`} context="Le téléphone ne s'y reconnectera plus tout seul. Pour relier un agent, il faudra scanner un nouveau QR code." onClose={onClose}>
      <SheetButton label="Oublier ce Mac" onPress={onConfirm} style={styles.sheetButton} />
    </Sheet>
  );
}

interface InviteSheetProps {
  readonly invite: PairingInvite | null;
  readonly replacing: string | null;
  readonly onClose: () => void;
  readonly onConfirm: (invite: PairingInvite) => void;
}

/** Asks before a scanned QR code or an opened link pairs with a Mac, since either can come from anyone. */
export function InviteSheet({ invite, replacing, onClose, onConfirm }: InviteSheetProps) {
  const { colors } = useTheme();
  const [shown, setShown] = useState<PairingInvite | null>(invite);
  useEffect(() => {
    if (invite !== null) setShown(invite);
  }, [invite]);
  const context =
    replacing === null
      ? "Ce téléphone ouvrira ton suivi aux agents lancés sur ce Mac, quand l'écran Agent est ouvert."
      : `Ce téléphone ouvrira ton suivi aux agents lancés sur ce Mac, à la place de ${replacing}.`;
  return (
    <Sheet open={invite !== null} title={`Relier ${shown?.name ?? ""} ?`} context={context} onClose={onClose}>
      <View style={[styles.inviteHosts, { borderColor: colors.line }]}>
        <Text variant="caption" tone="secondary">
          Adresses annoncées
        </Text>
        {(shown?.hosts ?? []).map((host) => (
          <Text key={host} style={styles.inviteHost}>
            {host}
          </Text>
        ))}
      </View>
      <SheetButton label="Relier ce Mac" onPress={() => (shown === null ? undefined : onConfirm(shown))} style={styles.sheetButton} />
    </Sheet>
  );
}

interface HostSheetProps {
  readonly open: boolean;
  readonly host: string | null;
  readonly onClose: () => void;
  readonly onSave: (host: string) => void;
}

export function HostSheet({ open, host, onClose, onSave }: HostSheetProps) {
  const [draft, setDraft] = useState(host ?? "");
  useEffect(() => {
    if (open) setDraft(host ?? "");
  }, [open, host]);
  const normalized = normalizeHost(draft);
  const save = (): void => {
    if (normalized !== null) onSave(normalized);
  };
  return (
    <Sheet open={open} title="Adresse du Mac" context="Adresse IP du Mac sur le Wi-Fi ou sur Tailscale, listée par obnixe-bridge pair. Une fois relié, le téléphone suit seul ses changements d'adresse." onClose={onClose}>
      <TextField
        value={draft}
        onChangeText={setDraft}
        placeholder="192.168.1.24"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="done"
        onSubmitEditing={save}
        accessibilityLabel="Adresse du Mac"
        autoFocus
      />
      <SheetButton label="Enregistrer" onPress={save} disabled={normalized === null} style={styles.sheetButton} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  appbar: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  appbarContext: { flex: 1 },
  head: { marginTop: 14, gap: 6 },
  headTitle: { fontFamily: fonts.text700, fontSize: 30, lineHeight: 33, letterSpacing: -0.6 },
  historyLink: { marginTop: 20, borderTopWidth: 1, minHeight: 56, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12 },
  forget: { borderTopWidth: 1, minHeight: 56, paddingVertical: 10, flexDirection: "row", alignItems: "center" },
  rowMain: { flex: 1, minWidth: 0, gap: 3 },
  bottomPanel: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopWidth: 1, paddingTop: 10, paddingHorizontal: layout.gutter },
  code: { marginTop: 18, paddingTop: 20, paddingHorizontal: 16, paddingBottom: 16, borderRadius: radii.panel, alignItems: "center", gap: 10 },
  codeDigits: { flexDirection: "row", gap: 14 },
  codeGroup: { fontFamily: fonts.figure800, fontSize: 76, lineHeight: 70, letterSpacing: 1.5 },
  expiry: { fontSize: 15, lineHeight: 20 },
  expiryClock: { fontFamily: fonts.figure700, fontSize: 17 },
  steps: { marginTop: 12 },
  scan: { marginTop: 14, gap: 16 },
  scanText: { lineHeight: 23 },
  manual: { marginTop: 20, borderTopWidth: 1, minHeight: 56, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12 },
  step: { flexDirection: "row", gap: 10, paddingVertical: 10 },
  stepNumber: { width: 24, fontFamily: fonts.figure700, fontSize: 15, lineHeight: 22 },
  stepText: { flex: 1, lineHeight: 22 },
  command: { fontFamily: monospace, fontSize: 14, borderRadius: 4 },
  network: { marginTop: 6, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radii.control },
  networkText: { flex: 1 },
  networkPrompt: { fontFamily: fonts.text700, textDecorationLine: "underline" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotRing: { borderWidth: 1.5 },
  permission: { minHeight: 64, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12 },
  permissionText: { flex: 1, gap: 3 },
  plainTag: { fontFamily: fonts.text700, fontSize: 12, lineHeight: 20, letterSpacing: 0.24 },
  tagStart: { alignSelf: "flex-start" },
  tag: { alignSelf: "flex-start", minHeight: 20, paddingHorizontal: 6, borderRadius: radii.tag, borderWidth: 1, justifyContent: "center" },
  tagLabel: { fontFamily: fonts.text700, fontSize: 12, lineHeight: 14, letterSpacing: 0.24 },
  activity: { flexDirection: "row", alignItems: "flex-start", gap: 12, minHeight: 56, paddingVertical: 10 },
  activityWide: { paddingVertical: 12 },
  time: { width: 44, fontFamily: fonts.figure600, fontSize: 15, lineHeight: 22 },
  timeWide: { width: 48 },
  activityMain: { flex: 1, minWidth: 0, gap: 3 },
  activityMainWide: { gap: 4 },
  activityTitle: { lineHeight: 21 },
  reverted: { textDecorationLine: "line-through" },
  tool: { fontFamily: monospace, fontSize: 12, lineHeight: 15 },
  activityAction: { minHeight: layout.hitSlop, marginTop: -8, marginRight: -10, paddingHorizontal: 10, borderRadius: radii.control, justifyContent: "center" },
  linkLabel: { fontFamily: fonts.text700, textDecorationLine: "underline" },
  status: { marginTop: 18, paddingVertical: 14, paddingHorizontal: 16, borderRadius: radii.panel, borderLeftWidth: 3, gap: 4 },
  statusHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusEyebrow: { fontFamily: fonts.text700, fontSize: 12, lineHeight: 14, letterSpacing: 0.72, textTransform: "uppercase" },
  statusTitle: { fontFamily: fonts.text700, fontSize: 20, lineHeight: 24 },
  sheetButton: { marginTop: 14 },
  inviteHosts: { borderTopWidth: 1, borderBottomWidth: 1, paddingVertical: 10, gap: 4 },
  inviteHost: { fontFamily: monospace, fontSize: 15, lineHeight: 21 },
});
