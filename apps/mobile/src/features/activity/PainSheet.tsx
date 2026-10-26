import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { ZonePain } from "@obnixe/core";
import type { PainLevel, ZoneKey } from "@obnixe/schema";
import { OtherZoneButton } from "@/features/activity/components";
import { zoneLabel } from "@/features/activity/presentation";
import { SheetButton } from "@/ui/Button";
import { PainLevels } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";

export interface PainZoneRow {
  readonly zone: ZoneKey;
  readonly detail: string | null;
  readonly levels: readonly PainLevel[];
}

interface PainSheetProps {
  readonly open: boolean;
  readonly context: string;
  readonly rows: readonly PainZoneRow[];
  readonly others: readonly ZoneKey[];
  readonly onSave: (pains: readonly ZonePain[]) => void;
  readonly onClose: () => void;
}

export function PainSheet({ open, context, rows, others, onSave, onClose }: PainSheetProps) {
  const { colors } = useTheme();
  const [pending, setPending] = useState<Partial<Record<ZoneKey, PainLevel>>>({});
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (open) {
      setPending({});
      setExpanded(false);
    }
  }, [open]);

  const shown: readonly PainZoneRow[] = expanded ? [...rows, ...others.map((zone) => ({ zone, detail: null, levels: ["discomfort", "stop"] as const }))] : rows;
  const entries = Object.entries(pending).map(([zone, level]): ZonePain => ({ zone: zone as ZoneKey, level: level as PainLevel }));

  return (
    <Sheet open={open} title="Signaler une douleur" context={context} onClose={onClose}>
      {shown.map((row, index) => (
        <View key={row.zone} style={[styles.zone, { borderTopColor: colors.line, borderTopWidth: index === 0 ? 0 : 1 }]}>
          <View style={styles.name}>
            <Text variant="bodyStrong">{zoneLabel(row.zone)}</Text>
            {row.detail === null ? null : (
              <Text variant="caption" tone="secondary" style={styles.detail}>
                {row.detail}
              </Text>
            )}
          </View>
          <PainLevels
            label={zoneLabel(row.zone)}
            levels={row.levels}
            value={pending[row.zone] ?? null}
            onChange={(level) => {
              const next = { ...pending };
              if (level === null) delete next[row.zone];
              else next[row.zone] = level;
              setPending(next);
            }}
          />
        </View>
      ))}
      {expanded || others.length === 0 ? null : <OtherZoneButton label="Autre zone…" onPress={() => setExpanded(true)} />}
      <SheetButton label="Enregistrer" disabled={entries.length === 0} style={styles.save} onPress={() => onSave(entries)} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  zone: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  name: { flex: 1, gap: 2 },
  detail: { fontFamily: fonts.text500 },
  save: { marginTop: 14 },
});
