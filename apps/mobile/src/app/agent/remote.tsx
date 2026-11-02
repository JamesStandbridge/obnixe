import type { ReactNode } from "react";
import { Pressable, Share, StyleSheet, View } from "react-native";
import { localDateOf } from "@obnixe/core";
import type { RemoteGrant } from "@obnixe/core";
import { environment } from "@/data/database";
import { AgentAppBar, Heading } from "@/features/agent/components";
import { remoteAccess, useRemoteAccess } from "@/features/remote/access";
import { Address, LinkPanel } from "@/features/remote/components";
import { deviceTimeZone, formatTimeAt, relativeDay } from "@/format/dates";
import { ControlButton, PrimaryButton } from "@/ui/Button";
import { Section, Screen } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";
import { goBack } from "@/ui/navigation";

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

export default function RemoteAccessScreen() {
  const state = useRemoteAccess();
  const address = state.origin === null ? null : `${state.origin}/mcp`;
  return (
    <View style={styles.root}>
      <Screen>
        <AgentAppBar onBack={() => goBack("/agent")} />
        <Heading title="Accès à distance" />
        <Text tone="secondary" style={styles.intro}>
          Claude, sur ce téléphone ou ailleurs, utilise ton suivi sans ordinateur. Le téléphone sert lui-même les outils ; le relais Obnixe ne fait que transmettre les échanges et ne garde rien.
        </Text>
        {!state.available ? (
          <Text tone="secondary" style={styles.intro}>
            Disponible dans l'application Android.
          </Text>
        ) : state.origin === null ? (
          <PrimaryButton label="Activer l'accès à distance" onPress={() => remoteAccess.enable()} style={styles.toggle} />
        ) : (
          <>
            <LinkPanel link={state.link} enabled={state.enabled} />
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
              onPress={() => (state.enabled ? remoteAccess.disable() : remoteAccess.enable())}
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
  toggle: { marginTop: 18 },
  grant: { minHeight: 56, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12 },
  grantMain: { flex: 1, minWidth: 0, gap: 3 },
  revoke: { minHeight: 44, paddingHorizontal: 10, marginRight: -10, justifyContent: "center" },
  revokeLabel: { fontFamily: fonts.text700, textDecorationLine: "underline" },
  empty: { paddingVertical: 14 },
});
