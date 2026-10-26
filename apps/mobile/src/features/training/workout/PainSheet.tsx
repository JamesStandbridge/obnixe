import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { PainLevel, ZoneKey } from "@obnixe/schema";
import { zoneLabel } from "@/format/labels";
import { SheetButton } from "@/ui/Button";
import { Choices, PainLevels } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";

export interface PainZoneOption {
  readonly zone: ZoneKey;
  readonly tracked: boolean;
}

export type PainStep = "zones" | "stop";

type StopChoice = "stop" | "replace" | "continue";

interface PainSheetProps {
  readonly open: boolean;
  readonly step: PainStep;
  readonly context: string;
  readonly zones: readonly PainZoneOption[];
  readonly otherZones: readonly ZoneKey[];
  readonly pending: ReadonlyMap<ZoneKey, PainLevel>;
  readonly stopTitle: string;
  readonly onChange: (zone: ZoneKey, level: PainLevel | null) => void;
  readonly onSave: () => void;
  readonly onClose: () => void;
  readonly onStopExercise: () => void;
  readonly onReplace: () => void;
}

const trackedLevels: readonly PainLevel[] = ["none", "discomfort", "stop"];
const newLevels: readonly PainLevel[] = ["discomfort", "stop"];

export function PainSheet({ open, step, context, zones, otherZones, pending, stopTitle, onChange, onSave, onClose, onStopExercise, onReplace }: PainSheetProps) {
  const { colors } = useTheme();
  const [showOther, setShowOther] = useState(false);
  useEffect(() => {
    if (open) setShowOther(false);
  }, [open]);

  if (step === "stop") {
    return (
      <Sheet open={open} title={stopTitle} context="Douleur enregistrée" onClose={onClose}>
        <Choices<StopChoice>
          items={[
            { value: "stop", label: "Arrêter l'exercice", primary: true },
            { value: "replace", label: "Remplacer l'exercice" },
            { value: "continue", label: "Continuer quand même" },
          ]}
          onChoose={(choice) => {
            switch (choice) {
              case "stop":
                onStopExercise();
                return;
              case "replace":
                onReplace();
                return;
              case "continue":
                onClose();
                return;
              default: {
                const unreachable: never = choice;
                return unreachable;
              }
            }
          }}
        />
      </Sheet>
    );
  }

  const rows = [...zones, ...(showOther ? otherZones.map((zone) => ({ zone, tracked: false })) : [])];
  return (
    <Sheet open={open} title="Signaler une douleur" context={context} onClose={onClose}>
      {rows.map((option) => (
        <View key={option.zone} style={[styles.zone, { borderTopColor: colors.line }]}>
          <View style={styles.zoneName}>
            <Text variant="bodyStrong">{zoneLabel(option.zone)}</Text>
            {option.tracked ? (
              <Text variant="caption" tone="secondary" style={styles.zoneDetail}>
                suivi en cours
              </Text>
            ) : null}
          </View>
          <PainLevels label={zoneLabel(option.zone)} value={pending.get(option.zone) ?? null} levels={option.tracked ? trackedLevels : newLevels} onChange={(level) => onChange(option.zone, level)} />
        </View>
      ))}
      {showOther || otherZones.length === 0 ? null : (
        <Pressable accessibilityRole="button" onPress={() => setShowOther(true)} style={({ pressed }) => [styles.other, { borderTopColor: colors.line }, pressed && { backgroundColor: colors.surfacePress }]}>
          <Text style={styles.otherLabel} tone="secondary">
            Autre zone…
          </Text>
        </Pressable>
      )}
      <SheetButton label="Enregistrer" disabled={pending.size === 0} onPress={onSave} style={styles.save} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  zone: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, borderTopWidth: 1 },
  zoneName: { flex: 1, gap: 2 },
  zoneDetail: { fontFamily: fonts.text500 },
  other: { height: 48, borderTopWidth: 1, alignItems: "center", justifyContent: "center" },
  otherLabel: { fontFamily: fonts.text600, fontSize: 16 },
  save: { marginTop: 14 },
});
