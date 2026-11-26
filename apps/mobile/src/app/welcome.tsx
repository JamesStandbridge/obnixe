import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
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
import { BrandHero } from "@/ui/illustrations/BrandHero";
import { Screen, Section } from "@/ui/Layout";
import { reveal } from "@/ui/motion";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii } from "@/ui/tokens";

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

        <Animated.View entering={reveal(0)} style={styles.hero}>
          <BrandHero size={220} />
        </Animated.View>

        <Animated.View entering={reveal(1)} style={styles.intro}>
          <Text style={styles.headline}>Ton suivi sportif, sans compte</Text>
        </Animated.View>

        <Section title="À savoir" style={styles.facts}>
          {facts.map((fact, index) => (
            <View key={fact} style={[styles.fact, { borderBottomColor: colors.line, borderBottomWidth: index === facts.length - 1 ? 0 : 1 }]}>
              <Text style={[styles.factNumber, { color: colors.mark }]}>
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
                      style={({ pressed: touching }) => [styles.sport, { backgroundColor: pressed ? colors.sport[sport] : touching ? colors.surfacePress : colors.surface }]}
                    >
                      <SportIcon sport={sport} variant="inline" color={pressed ? colors.sportInk : colors.sport[sport]} />
                      <Text variant="label" tone={pressed ? "primary" : "secondary"} style={pressed ? [styles.sportOn, { color: colors.sportInk }] : null}>
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
  wordmark: { marginTop: 28, fontFamily: fonts.brand800, fontSize: 30, lineHeight: 34, letterSpacing: 1.2 },
  hero: { marginTop: 18, alignItems: "center" },
  intro: { marginTop: 18, gap: 10 },
  headline: { fontFamily: fonts.brand800, fontSize: 36, lineHeight: 39, letterSpacing: -0.9 },
  facts: { marginTop: 8 },
  fact: { flexDirection: "row", alignItems: "flex-start", gap: 12, minHeight: 56, paddingVertical: 10 },
  factNumber: { width: 28, fontFamily: fonts.figure800, fontSize: 17, lineHeight: 22 },
  factText: { flex: 1, lineHeight: 22 },
  sports: { marginTop: 10, gap: 6 },
  sportRow: { flexDirection: "row", gap: 6 },
  sportSpacer: { flex: 1 },
  sport: { flex: 1, minHeight: 52, paddingHorizontal: 12, borderRadius: radii.control, flexDirection: "row", alignItems: "center", gap: 10 },
  sportOn: { fontFamily: fonts.brand700 },
  theme: { marginTop: 10 },
  stack: { gap: 4 },
  restore: { minHeight: 44, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
});
