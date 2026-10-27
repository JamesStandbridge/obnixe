import { useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import type { BarcodeScanningResult } from "expo-camera";
import { NotificationFeedbackType, notificationAsync } from "expo-haptics";
import { StatusBar } from "expo-status-bar";
import type { InviteErrorReason } from "@obnixe/core";
import { environment } from "@/data/database";
import { deliverPairingRequest, inviteProblemText, readInvite } from "@/features/agent/invites";
import { Heading } from "@/features/agent/components";
import { LinkButton, PrimaryButton } from "@/ui/Button";
import { Icon } from "@/ui/icons/Icon";
import { IconButton } from "@/ui/Inputs";
import { Screen } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { goBack } from "@/ui/navigation";
import { layout, palettes, radii } from "@/ui/tokens";

const frameSize = 248;
const cornerSize = 30;
const camera = palettes.dark;

function close(): void {
  goBack("/agent");
}

function switchToManual(): void {
  deliverPairingRequest({ kind: "manual" });
  close();
}

interface PermissionAskProps {
  readonly title: string;
  readonly detail: string;
  readonly action: string;
  readonly onAction: () => void;
}

function PermissionAsk({ title, detail, action, onAction }: PermissionAskProps) {
  return (
    <Screen>
      <View style={styles.bar}>
        <IconButton icon="close" label="Fermer" edge="start" onPress={close} />
      </View>
      <Heading title={title} />
      <Text tone="secondary" style={styles.detail}>
        {detail}
      </Text>
      <PrimaryButton label={action} onPress={onAction} style={styles.action} />
      <LinkButton label="Saisir l'adresse à la place" onPress={switchToManual} style={styles.fallback} />
    </Screen>
  );
}

function Corner({ edge }: { readonly edge: "topLeft" | "topRight" | "bottomLeft" | "bottomRight" }) {
  return <View style={[styles.corner, styles[edge], { borderColor: camera.mark }]} />;
}

function Viewfinder() {
  const insets = useSafeAreaInsets();
  const [problem, setProblem] = useState<InviteErrorReason | null>(null);
  const done = useRef(false);
  const last = useRef("");
  const onScanned = ({ data }: BarcodeScanningResult): void => {
    if (done.current || data === last.current) return;
    last.current = data;
    const request = readInvite(data, environment.now());
    if (request.kind === "invalid") {
      setProblem(request.reason);
      return;
    }
    done.current = true;
    void notificationAsync(NotificationFeedbackType.Success);
    deliverPairingRequest(request);
    close();
  };
  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScanned} />
      <View style={[styles.shade, styles.top, { paddingTop: insets.top + 14 }]}>
        <View style={styles.bar}>
          <Pressable accessibilityRole="button" accessibilityLabel="Fermer" onPress={close} style={({ pressed }) => [styles.close, pressed && { backgroundColor: camera.surfacePress }]}>
            <Icon name="close" color={camera.text} />
          </Pressable>
        </View>
        <Text variant="title" accessibilityRole="header" style={{ color: camera.text }}>
          Scanne le QR code de l'ordinateur
        </Text>
      </View>
      <View style={styles.middle}>
        <View style={styles.shade} />
        <View style={styles.frame} accessibilityLabel="Zone de lecture du QR code">
          <Corner edge="topLeft" />
          <Corner edge="topRight" />
          <Corner edge="bottomLeft" />
          <Corner edge="bottomRight" />
        </View>
        <View style={styles.shade} />
      </View>
      <View style={[styles.shade, styles.bottom, { paddingBottom: insets.bottom + 20 }]}>
        <Text style={[styles.hint, { color: problem === null ? camera.text2 : camera.warn }]} accessibilityLiveRegion="polite">
          {problem === null ? "Lance obnixe-bridge pair dans un terminal de l'ordinateur, puis vise le code." : inviteProblemText(problem)}
        </Text>
        <LinkButton label="Pas de caméra ? Saisir l'adresse" onPress={switchToManual} style={styles.bottomLink} />
      </View>
    </View>
  );
}

export default function Scan() {
  const [permission, requestPermission] = useCameraPermissions();
  if (permission === null) return <View style={styles.root} />;
  if (permission.granted) return <Viewfinder />;
  if (permission.canAskAgain) {
    return (
      <PermissionAsk
        title="Autorise la caméra"
        detail="Obnixe s'en sert seulement pour lire le QR code affiché par obnixe-bridge. Aucune image n'est gardée."
        action="Autoriser la caméra"
        onAction={() => void requestPermission()}
      />
    );
  }
  return (
    <PermissionAsk
      title="Caméra refusée"
      detail="Autorise la caméra pour Obnixe dans les réglages du téléphone, ou relie l'ordinateur avec son adresse et un code."
      action="Ouvrir les réglages"
      onAction={() => void Linking.openSettings()}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: camera.bg },
  bar: { flexDirection: "row", alignItems: "center", minHeight: 44 },
  close: { width: layout.hitSlop, height: layout.hitSlop, marginLeft: -12, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
  detail: { marginTop: 8, lineHeight: 23 },
  action: { marginTop: 24 },
  fallback: { marginTop: 12, alignSelf: "flex-start", marginLeft: -10 },
  shade: { flex: 1, backgroundColor: camera.scrim },
  top: { paddingHorizontal: layout.gutter, justifyContent: "flex-start", gap: 12 },
  middle: { height: frameSize, flexDirection: "row" },
  frame: { width: frameSize, height: frameSize },
  corner: { position: "absolute", width: cornerSize, height: cornerSize },
  topLeft: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: radii.panel },
  topRight: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: radii.panel },
  bottomLeft: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: radii.panel },
  bottomRight: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: radii.panel },
  bottom: { paddingHorizontal: layout.gutter, paddingTop: 20, gap: 8 },
  hint: { textAlign: "center" },
  bottomLink: { alignSelf: "center" },
});
