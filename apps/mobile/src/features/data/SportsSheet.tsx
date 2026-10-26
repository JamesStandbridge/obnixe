import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { lockedSports, moveSportMutations, setSportEnabledMutations, sportChoices } from "@obnixe/core";
import { sportPreference, sports } from "@obnixe/schema";
import type { SportKey } from "@obnixe/schema";
import { db } from "@/data/database";
import { write } from "@/data/write";
import { useDatabaseVersion } from "@/features/data/useDatabaseVersion";
import { SwitchRow } from "@/features/data/parts";
import { LinkButton } from "@/ui/Button";
import { SportIcon } from "@/ui/icons/SportIcon";
import { IconButton } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";

interface SportsSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function SportsSheet({ open, onClose }: SportsSheetProps) {
  const { colors } = useTheme();
  const { data: preferences } = useLiveQuery(db().select().from(sportPreference));
  useDatabaseVersion(["program", "program_version", "program_slot"]);
  const locked = lockedSports(db());
  const [ordering, setOrdering] = useState(false);
  const [frozenOrder, setFrozenOrder] = useState<readonly SportKey[] | null>(null);
  const live = sportChoices(preferences);
  const enabledCount = live.filter((choice) => choice.enabled).length;
  const rank = (sport: SportKey): number => {
    const index = frozenOrder?.indexOf(sport) ?? -1;
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const choices = ordering || frozenOrder === null ? live : [...live].sort((left, right) => rank(left.sport) - rank(right.sport));

  const toggle = (sport: SportKey, enabled: boolean): void => {
    if (frozenOrder === null) setFrozenOrder(live.map((choice) => choice.sport));
    const mutations = setSportEnabledMutations(preferences, sport, enabled, locked);
    if (mutations.length > 0) write(`${sports[sport].label} ${enabled ? "affiché" : "masqué"}`, mutations);
  };

  const move = (sport: SportKey, offset: -1 | 1): void => {
    const mutations = moveSportMutations(preferences, sport, offset);
    if (mutations.length > 0) write(`Ordre des sports`, mutations);
  };

  return (
    <Sheet
      open={open}
      title="Sports"
      onClose={() => {
        setOrdering(false);
        setFrozenOrder(null);
        onClose();
      }}
    >
      <View>
        {choices.map((choice, index) => {
          const isLocked = locked.has(choice.sport) && choice.enabled;
          const label = sports[choice.sport].label;
          if (ordering && choice.enabled) {
            return (
              <View key={choice.sport} style={[styles.orderRow, { borderTopColor: colors.line }]}>
                <SportIcon sport={choice.sport} />
                <Text style={styles.orderLabel}>{label}</Text>
                {index === 0 ? <View style={styles.placeholder} /> : <IconButton icon="collapse" label={`Monter ${label}`} onPress={() => move(choice.sport, -1)} />}
                {index === enabledCount - 1 ? <View style={styles.placeholder} /> : <IconButton icon="expand" label={`Descendre ${label}`} onPress={() => move(choice.sport, 1)} />}
              </View>
            );
          }
          if (ordering) return null;
          return (
            <SwitchRow
              key={choice.sport}
              title={label}
              {...(isLocked ? { detail: "dans le programme actif" } : {})}
              leading={<SportIcon sport={choice.sport} />}
              value={choice.enabled}
              disabled={isLocked}
              onChange={(enabled) => toggle(choice.sport, enabled)}
              divided
              large
            />
          );
        })}
      </View>
      {enabledCount > 1 ? (
        <View style={styles.footer}>
          <LinkButton
            label={ordering ? "Terminé" : "Changer l'ordre"}
            onPress={() => {
              setFrozenOrder(null);
              setOrdering((current) => !current);
            }}
          />
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  orderRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, borderTopWidth: 1 },
  orderLabel: { flex: 1, fontFamily: fonts.text600, fontSize: 17, lineHeight: 22 },
  placeholder: { width: 44, height: 44 },
  footer: { flexDirection: "row", justifyContent: "flex-end", marginTop: 8 },
});
