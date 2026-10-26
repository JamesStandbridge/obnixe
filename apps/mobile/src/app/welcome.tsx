import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { initialSportMutations } from "@obnixe/core";
import { settings, sportKeys, sports } from "@obnixe/schema";
import type { SportKey, Theme } from "@obnixe/schema";
import { db } from "@/data/database";
import { write } from "@/data/write";
import { BottomPanel } from "@/features/data/parts";
import { updateSettings } from "@/data/settings";
import { PrimaryButton } from "@/ui/Button";
import { Segmented } from "@/ui/Controls";
import { SportIcon } from "@/ui/icons/SportIcon";
import { Screen, Section } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";

const defaultSports: ReadonlySet<SportKey> = new Set<SportKey>(["strength", "run", "climb", "hike", "swim"]);

const facts = ["Tout reste sur ce téléphone", "Sauvegarde par fichier, à exporter", "Un agent n'entre qu'avec ton code"] as const;

const themeOptions: readonly { readonly value: Theme; readonly label: string }[] = [
  { value: "dark", label: "Sombre" },
  { value: "sunlight", label: "Plein soleil" },
  { value: "system", label: "Système" },
];

const preferredOrder: readonly SportKey[] = ["strength", "run", "climb", "hike", "swim", "bike", "yoga"];
const offered = [...preferredOrder, ...sportKeys.filter((sport) => !preferredOrder.includes(sport))].filter((sport) => !("retired" in sports[sport]));
const pairs: readonly (readonly SportKey[])[] = offered.reduce<SportKey[][]>((rows, sport, index) => {
  if (index % 2 === 0) rows.push([sport]);
  else rows[rows.length - 1]?.push(sport);
  return rows;
}, []);

export default function Welcome() {
  const { colors } = useTheme();
  const [selected, setSelected] = useState<ReadonlySet<SportKey>>(defaultSports);
  const { data: settingsRows } = useLiveQuery(db().select({ theme: settings.theme }).from(settings));

  const toggle = (sport: SportKey): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(sport)) next.delete(sport);
      else next.add(sport);
      return next;
    });
  };

  return (
    <View style={styles.root}>
      <Screen bottomInset={172}>
        <Text accessibilityRole="header" accessibilityLabel="Obnixe" style={styles.wordmark}>
          OBNI<Text style={[styles.wordmark, { color: colors.mark }]}>X</Text>E
        </Text>

        <View style={styles.intro}>
          <Text style={styles.headline}>Ton suivi sportif, sans compte</Text>
        </View>

        <Section title="À savoir" style={styles.facts}>
          {facts.map((fact, index) => (
            <View key={fact} style={[styles.fact, { borderBottomColor: colors.line, borderBottomWidth: index === facts.length - 1 ? 0 : 1 }]}>
              <Text tone="tertiary" style={styles.factNumber}>
                {index + 1}
              </Text>
              <Text variant="bodyStrong" style={styles.factText}>
                {fact}
              </Text>
            </View>
          ))}
        </Section>

        <Section title="Tes sports">
          <View style={styles.sports} accessibilityLabel="Sports pratiqués">
            {pairs.map((pair) => (
              <View key={pair.join("-")} style={styles.sportRow}>
                {pair.map((sport) => {
                  const pressed = selected.has(sport);
                  return (
                    <Pressable
                      key={sport}
                      accessibilityRole="checkbox"
                      aria-checked={pressed}
                      accessibilityLabel={sports[sport].label}
                      onPress={() => toggle(sport)}
                      style={({ pressed: touching }) => [
                        styles.sport,
                        {
                          borderColor: pressed ? colors.text : colors.controlBorder,
                          borderWidth: pressed ? 2 : layout.borderControl,
                          backgroundColor: pressed || touching ? colors.surface : "transparent",
                        },
                      ]}
                    >
                      <SportIcon sport={sport} variant="inline" color={pressed ? colors.text : colors.text2} />
                      <Text variant="label" tone={pressed ? "primary" : "secondary"} style={pressed ? styles.sportOn : null}>
                        {sports[sport].label}
                      </Text>
                    </Pressable>
                  );
                })}
                {pair.length === 1 ? <View style={styles.sportSpacer} /> : null}
              </View>
            ))}
          </View>
        </Section>

        <Section title="Affichage">
          <View style={styles.theme}>
            <Segmented options={themeOptions} value={settingsRows[0]?.theme ?? "dark"} onChange={(theme) => updateSettings({ theme })} />
          </View>
        </Section>
      </Screen>

      <BottomPanel>
        <View style={styles.stack}>
          <PrimaryButton label="Commencer" disabled={selected.size === 0} onPress={() => write("Choix des sports", initialSportMutations(offered, selected))} />
          <Pressable accessibilityRole="link" onPress={() => router.push("/import")} style={({ pressed }) => [styles.restore, pressed && { backgroundColor: colors.surface }]}>
            <Text variant="label" tone="secondary">
              J'ai déjà une sauvegarde
            </Text>
          </Pressable>
        </View>
      </BottomPanel>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  wordmark: { marginTop: 28, fontFamily: fonts.figure800, fontSize: 34, lineHeight: 34, letterSpacing: 0.7 },
  intro: { marginTop: 28, gap: 10 },
  headline: { fontFamily: fonts.text700, fontSize: 34, lineHeight: 36, letterSpacing: -0.7 },
  facts: { marginTop: 8 },
  fact: { flexDirection: "row", alignItems: "flex-start", gap: 12, minHeight: 56, paddingVertical: 10 },
  factNumber: { width: 28, fontFamily: fonts.figure700, fontSize: 15, lineHeight: 22 },
  factText: { flex: 1, lineHeight: 22 },
  sports: { marginTop: 10, gap: 6 },
  sportRow: { flexDirection: "row", gap: 6 },
  sportSpacer: { flex: 1 },
  sport: { flex: 1, minHeight: 52, paddingHorizontal: 12, borderRadius: radii.control, flexDirection: "row", alignItems: "center", gap: 10 },
  sportOn: { fontFamily: fonts.text700 },
  theme: { marginTop: 10 },
  stack: { gap: 4 },
  restore: { minHeight: 44, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
});
