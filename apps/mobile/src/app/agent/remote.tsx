import { useState } from "react";
import type { ReactNode } from "react";
import { Linking, Pressable, Share, StyleSheet, View } from "react-native";
import { localDateOf } from "@obnixe/core";
import type { RemoteGrant } from "@obnixe/core";
import { environment } from "@/data/database";
import { AgentAppBar, Heading } from "@/features/agent/components";
import { remoteAccess, useRemoteAccess } from "@/features/remote/access";
import { Address, TunnelPanel } from "@/features/remote/components";
import { deviceTimeZone, formatTimeAt, relativeDay } from "@/format/dates";
import { ControlButton, LinkButton, PrimaryButton } from "@/ui/Button";
import { TextField } from "@/ui/Inputs";
import { Section, Screen } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";
import { goBack } from "@/ui/navigation";

const signupUrl = "https://dashboard.ngrok.com/signup";
const authtokenUrl = "https://dashboard.ngrok.com/get-started/your-authtoken";

function open(url: string): void {
  Linking.openURL(url).catch((error: unknown) => ErrorUtils.getGlobalHandler()(error, false));
}

function shareAddress(address: string): void {
  Share.share({ message: address }).catch((error: unknown) => ErrorUtils.getGlobalHandler()(error, false));
}

interface StepsProps {
  readonly steps: readonly ReactNode[];
}

function Steps({ steps }: StepsProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.steps} accessibilityRole="list">
      {steps.map((step, index) => (
        <View key={index} style={[styles.step, { borderBottomColor: colors.line, borderBottomWidth: index === steps.length - 1 ? 0 : 1 }]}>
          <Text tone="tertiary" style={styles.stepNumber}>
            {index + 1}
          </Text>
          <View style={styles.stepBody}>{step}</View>
        </View>
      ))}
    </View>
  );
}

function grantSince(grant: RemoteGrant): string {
  const zone = deviceTimeZone();
  return `depuis ${relativeDay(localDateOf(grant.createdAt, zone), localDateOf(environment.now(), zone))} à ${formatTimeAt(grant.createdAt, zone)}`;
}

interface GrantRowProps {
  readonly grant: RemoteGrant;
  readonly last: boolean;
}

function GrantRow({ grant, last }: GrantRowProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.grant, { borderBottomColor: colors.line, borderBottomWidth: last ? 0 : 1 }]}>
      <View style={styles.grantMain}>
        <Text variant="bodyStrong">{grant.client}</Text>
        <Text variant="small" tone="secondary">
          {grantSince(grant)}
        </Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`Révoquer ${grant.client}`} onPress={() => remoteAccess.revoke(grant.id)} style={styles.revoke}>
        <Text variant="small" style={styles.revokeLabel}>
          Révoquer
        </Text>
      </Pressable>
    </View>
  );
}

function Setup() {
  const [draft, setDraft] = useState("");
  const authtoken = draft.trim();
  const valid = /^[A-Za-z0-9_-]{20,}$/.test(authtoken);
  const enable = (): void => {
    if (valid) remoteAccess.enable(authtoken);
  };
  return (
    <Steps
      steps={[
        <>
          <Text>Crée un compte gratuit sur ngrok.com</Text>
          <LinkButton label="Ouvrir ngrok.com" onPress={() => open(signupUrl)} style={styles.stepLink} />
        </>,
        <>
          <Text>Copie ton authtoken, puis colle-le ici</Text>
          <LinkButton label="Voir mon authtoken" onPress={() => open(authtokenUrl)} style={styles.stepLink} />
          <TextField
            value={draft}
            onChangeText={setDraft}
            placeholder="2abc…"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            returnKeyType="done"
            onSubmitEditing={enable}
            accessibilityLabel="Authtoken ngrok"
            style={styles.field}
          />
        </>,
        <PrimaryButton label="Activer l'accès à distance" onPress={enable} disabled={!valid} />,
      ]}
    />
  );
}

export default function RemoteAccessScreen() {
  const state = useRemoteAccess();
  const address = state.tunnel.state === "online" && state.tunnel.url !== "" ? `${state.tunnel.url}/mcp` : null;
  return (
    <View style={styles.root}>
      <Screen>
        <AgentAppBar onBack={() => goBack("/agent")} />
        <Heading title="Accès à distance" />
        <Text tone="secondary" style={styles.intro}>
          Claude, sur ce téléphone ou ailleurs, utilise ton suivi sans ordinateur. Le téléphone sert lui-même les outils, à travers un tunnel ngrok gratuit à ton nom. Rien n'est stocké en dehors du téléphone.
        </Text>
        {!state.available ? (
          <Text tone="secondary" style={styles.intro}>
            Disponible dans l'application Android.
          </Text>
        ) : !state.hasAuthtoken ? (
          <Setup />
        ) : (
          <>
            <TunnelPanel status={state.tunnel} enabled={state.enabled} />
            {address === null || !state.enabled ? null : (
              <>
                <Address address={address} onShare={() => shareAddress(address)} />
                <Steps
                  steps={[
                    <Text>Dans Claude : Réglages, Connecteurs, Ajouter un connecteur personnalisé, puis colle l'adresse</Text>,
                    <Text>Valide la demande qui s'affiche alors sur ce téléphone</Text>,
                  ]}
                />
              </>
            )}
            <ControlButton
              label={state.enabled ? "Couper l'accès à distance" : "Rétablir l'accès à distance"}
              onPress={() => (state.enabled ? remoteAccess.disable() : remoteAccess.resume())}
              style={styles.toggle}
            />
            <Section title="Agents autorisés">
              {state.grants.length === 0 ? (
                <Text variant="small" tone="secondary" style={styles.empty}>
                  Aucun agent pour l'instant
                </Text>
              ) : (
                state.grants.map((grant, position) => <GrantRow key={grant.id} grant={grant} last={position === state.grants.length - 1} />)
              )}
            </Section>
            <LinkButton label="Changer de compte ngrok" onPress={() => remoteAccess.forgetAuthtoken()} style={styles.forget} />
          </>
        )}
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  intro: { marginTop: 10, lineHeight: 23 },
  steps: { marginTop: 12 },
  step: { flexDirection: "row", gap: 10, paddingVertical: 12 },
  stepNumber: { width: 24, fontSize: 15, lineHeight: 22 },
  stepBody: { flex: 1, gap: 8 },
  stepLink: { alignSelf: "flex-start", marginLeft: -10 },
  field: { marginTop: 4 },
  toggle: { marginTop: 18 },
  grant: { minHeight: 56, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12 },
  grantMain: { flex: 1, minWidth: 0, gap: 3 },
  revoke: { minHeight: 44, paddingHorizontal: 10, marginRight: -10, justifyContent: "center" },
  revokeLabel: { fontFamily: fonts.text700, textDecorationLine: "underline" },
  empty: { paddingVertical: 14 },
  forget: { alignSelf: "flex-start", marginTop: 14, marginLeft: -10 },
});
