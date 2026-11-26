import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { ResolvedProfile } from "@obnixe/core";
import type { MetricKey, Readout } from "@obnixe/schema";
import { metricCaptions, metricNames } from "@/features/recording/metrics";
import { liveMetricsOf, metricAt, secondaryLimits, withMetric, withSecondaryAdded, withSecondaryRemoved } from "@/features/recording/readout";
import type { ReadoutSlot } from "@/features/recording/readout";
import { LinkButton } from "@/ui/Button";
import { Icon } from "@/ui/icons/Icon";
import { MenuItem } from "@/ui/Inputs";
import { Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { BevelView } from "@/ui/Shapes";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { bevels, fonts, radii } from "@/ui/tokens";

type Editing = { readonly kind: "slot"; readonly slot: ReadoutSlot } | { readonly kind: "add" };

interface ReadoutEditorProps {
  readonly profile: ResolvedProfile;
  readonly readout: Readout;
  readonly customized: boolean;
  readonly onChange: (readout: Readout) => void;
  readonly onReset: () => void;
}

/** `SPT-005`: the main value and three to five secondary values of the sport's live screen. */
export function ReadoutEditor({ profile, readout, customized, onChange, onReset }: ReadoutEditorProps) {
  const { colors } = useTheme();
  const [editing, setEditing] = useState<Editing | null>(null);
  const available = liveMetricsOf(profile);
  const current = editing?.kind === "slot" ? metricAt(readout, editing.slot) : undefined;
  const removable = editing?.kind === "slot" && editing.slot.kind === "secondary" && readout.secondary.length > secondaryLimits.min ? editing.slot.index : null;
  const choices = editing?.kind === "add" ? available.filter((key) => key !== readout.main && !readout.secondary.includes(key)) : available;

  const choose = (key: MetricKey): void => {
    if (editing === null) return;
    const next = editing.kind === "add" ? withSecondaryAdded(readout, key) : withMetric(readout, editing.slot, key);
    setEditing(null);
    if (next !== null) onChange(next);
  };

  const remove = (): void => {
    const next = removable === null ? null : withSecondaryRemoved(readout, removable);
    setEditing(null);
    if (next !== null) onChange(next);
  };

  return (
    <Section title="Écran de direct" {...(customized ? { action: <LinkButton label="Rétablir" onPress={onReset} /> } : {})}>
      <BevelView fill={colors.surface} cut={bevels.card} style={styles.card}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Valeur principale, ${metricNames[readout.main]}`}
          accessibilityHint="Changer la donnée"
          onPress={() => setEditing({ kind: "slot", slot: { kind: "main" } })}
          style={({ pressed }) => [styles.main, { borderColor: colors.line }, pressed && { backgroundColor: colors.surfacePress }]}
        >
          <Text variant="eyebrow" tone="secondary">
            Principal
          </Text>
          <Text style={[styles.mainName, { color: colors.text }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
            {metricNames[readout.main]}
          </Text>
        </Pressable>
        <View style={styles.grid}>
          {readout.secondary.map((key, index) => (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={`Valeur ${index + 1}, ${metricNames[key]}`}
              accessibilityHint="Changer ou retirer la donnée"
              onPress={() => setEditing({ kind: "slot", slot: { kind: "secondary", index } })}
              style={({ pressed }) => [styles.cell, { backgroundColor: pressed ? colors.surfacePress : colors.surface2 }]}
            >
              <Text style={[styles.cellCaption, { color: colors.text2 }]} numberOfLines={1}>
                {metricCaptions[key]}
              </Text>
              <Text variant="label" numberOfLines={1}>
                {metricNames[key]}
              </Text>
            </Pressable>
          ))}
          {readout.secondary.length < secondaryLimits.max ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Ajouter une donnée"
              onPress={() => setEditing({ kind: "add" })}
              style={({ pressed }) => [styles.cell, styles.add, { borderColor: colors.controlBorder }, pressed && { backgroundColor: colors.surfacePress }]}
            >
              <Icon name="plus" size={18} color={colors.mark} />
              <Text variant="label" style={{ color: colors.mark }}>
                Ajouter
              </Text>
            </Pressable>
          ) : null}
        </View>
      </BevelView>
      <Text variant="caption" tone="secondary" style={styles.hint}>
        Pendant la sortie, les tours et la carte suivent sur les pages voisines.
      </Text>

      <Sheet
        open={editing !== null}
        title={editing?.kind === "add" ? "Ajouter une donnée" : "Choisir la donnée"}
        {...(current === undefined ? {} : { context: `Actuellement : ${metricNames[current]}` })}
        onClose={() => setEditing(null)}
      >
        <View>
          {choices.map((key) => (
            <MenuItem
              key={key}
              label={metricNames[key]}
              {...(key === current ? { leading: <Icon name="check" size={18} color={colors.mark} /> } : {})}
              {...(editing?.kind === "slot" && key !== current && (key === readout.main || readout.secondary.includes(key)) ? { detail: "Échange les places" } : {})}
              onPress={() => choose(key)}
            />
          ))}
          {removable === null ? null : <MenuItem label="Retirer de l'écran" destructive onPress={remove} />}
        </View>
      </Sheet>
    </Section>
  );
}

const styles = StyleSheet.create({
  card: { padding: 12, gap: 10 },
  main: { minHeight: 76, paddingHorizontal: 14, paddingVertical: 12, borderRadius: radii.control, borderWidth: 1, justifyContent: "center", gap: 4 },
  mainName: { fontFamily: fonts.figure800, fontSize: 30, lineHeight: 34 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  cell: { flexGrow: 1, flexBasis: "45%", minHeight: 56, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radii.control, justifyContent: "center", gap: 2 },
  cellCaption: { fontFamily: fonts.text700, fontSize: 11, lineHeight: 13, letterSpacing: 0.8, textTransform: "uppercase" },
  add: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderWidth: 1, borderStyle: "dashed" },
  hint: { marginTop: 8 },
});
