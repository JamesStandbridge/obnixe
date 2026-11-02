import { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import type { PendingAuthorization } from "@obnixe/core";
import { LinkButton, SheetButton } from "@/ui/Button";
import { Icon } from "@/ui/icons/Icon";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii } from "@/ui/tokens";
import type { TunnelStatus } from "../../../modules/obnixe-remote";

const monospace = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, SFMono-Regular, Menlo, monospace" });

export function tunnelLabel(status: TunnelStatus, enabled: boolean): string {
  if (!enabled) return "Coupé";
  switch (status.state) {
    case "online":
      return "En ligne";
    case "connecting":
      return "Connexion à ngrok…";
    case "reconnecting":
      return "Reconnexion…";
    case "error":
      return "Erreur";
    case "stopped":
      return "Démarrage…";
    default: {
      const unreachable: never = status.state;
      return unreachable;
    }
  }
}

interface RemoteLinkProps {
  readonly detail: string;
  readonly onPress: () => void;
}

export function RemoteLink({ detail, onPress }: RemoteLinkProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Accès à distance, ${detail}`}
      onPress={onPress}
      style={({ pressed }) => [styles.link, { borderTopColor: colors.line }, pressed && { backgroundColor: colors.surface }]}
    >
      <View style={styles.linkMain}>
        <Text variant="bodyStrong">Accès à distance</Text>
        <Text variant="small" tone="secondary">
          {detail}
        </Text>
      </View>
      <Icon name="chevron" size={16} color={colors.text3} />
    </Pressable>
  );
}

interface TunnelPanelProps {
  readonly status: TunnelStatus;
  readonly enabled: boolean;
}

export function TunnelPanel({ status, enabled }: TunnelPanelProps) {
  const { colors } = useTheme();
  const online = enabled && status.state === "online";
  const failed = enabled && status.state === "error";
  const label = tunnelLabel(status, enabled);
  const detail = !enabled
    ? "Les agents ne peuvent plus joindre ce téléphone"
    : online
      ? "Les agents autorisés peuvent joindre ce téléphone"
      : failed
        ? status.message
        : status.message === ""
          ? "Le téléphone ouvre son tunnel"
          : status.message;
  return (
    <View
      style={[styles.panel, { backgroundColor: colors.surface, borderLeftColor: online ? colors.mark : failed ? colors.warn : colors.text3 }]}
      accessible
      accessibilityLabel={`${label}, ${detail}`}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.panelHeader}>
        <View style={[styles.dot, online ? { backgroundColor: colors.mark } : [styles.dotRing, { borderColor: failed ? colors.warn : colors.text3 }]]} />
        <Text style={styles.panelEyebrow}>{label}</Text>
      </View>
      <Text variant="small" tone="secondary">
        {detail}
      </Text>
    </View>
  );
}

interface AddressProps {
  readonly address: string;
  readonly onShare: () => void;
}

export function Address({ address, onShare }: AddressProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.address, { borderColor: colors.line }]}>
      <Text variant="caption" tone="secondary">
        Adresse du connecteur
      </Text>
      <Text selectable style={styles.addressText}>
        {address}
      </Text>
      <LinkButton label="Partager l'adresse" onPress={onShare} style={styles.addressShare} />
    </View>
  );
}

interface ApprovalSheetProps {
  readonly request: PendingAuthorization | null;
  readonly onDecide: (id: string, approved: boolean) => void;
}

/** Asks before an agent gets remote access, since anyone who knows the address can start an authorization. */
export function ApprovalSheet({ request, onDecide }: ApprovalSheetProps) {
  const { colors } = useTheme();
  const [shown, setShown] = useState<PendingAuthorization | null>(request);
  useEffect(() => {
    if (request !== null) setShown(request);
  }, [request]);
  const refuse = (): void => {
    if (shown !== null) onDecide(shown.id, false);
  };
  return (
    <Sheet
      open={request !== null}
      title={`Autoriser ${shown?.client ?? ""} ?`}
      context="Cet agent pourra joindre ton suivi depuis n'importe où tant que l'accès à distance est actif, avec les autorisations de l'écran Agent. Tu pourras le révoquer à tout moment."
      onClose={refuse}
    >
      <View style={[styles.approvalHost, { borderColor: colors.line }]}>
        <Text variant="caption" tone="secondary">
          Retour vers
        </Text>
        <Text style={styles.addressText}>{shown?.host ?? ""}</Text>
      </View>
      <SheetButton label="Autoriser" onPress={() => (shown === null ? undefined : onDecide(shown.id, true))} style={styles.sheetButton} />
      <LinkButton label="Refuser" onPress={refuse} style={styles.refuse} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  link: { marginTop: 20, borderTopWidth: 1, minHeight: 56, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12 },
  linkMain: { flex: 1, minWidth: 0, gap: 3 },
  panel: { marginTop: 18, paddingVertical: 14, paddingHorizontal: 16, borderRadius: radii.panel, borderLeftWidth: 3, gap: 4 },
  panelHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  panelEyebrow: { fontFamily: fonts.text700, fontSize: 12, lineHeight: 14, letterSpacing: 0.72, textTransform: "uppercase" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotRing: { borderWidth: 1.5 },
  address: { marginTop: 18, borderTopWidth: 1, borderBottomWidth: 1, paddingTop: 10, gap: 4 },
  addressText: { fontFamily: monospace, fontSize: 15, lineHeight: 21 },
  addressShare: { alignSelf: "flex-start", marginLeft: -10 },
  approvalHost: { borderTopWidth: 1, borderBottomWidth: 1, paddingVertical: 10, gap: 4 },
  sheetButton: { marginTop: 14 },
  refuse: { alignSelf: "center", marginTop: 6 },
});
