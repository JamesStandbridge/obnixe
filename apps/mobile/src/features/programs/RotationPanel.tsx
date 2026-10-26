import { StyleSheet, View } from "react-native";
import { sports } from "@obnixe/schema";
import type { SportKey } from "@obnixe/schema";
import { SportIcon } from "@/ui/icons/SportIcon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii } from "@/ui/tokens";

export interface RotationRow {
  readonly key: string;
  readonly sport: SportKey;
  readonly title: string;
  readonly detail: string;
  readonly next: boolean;
  readonly value: string | null;
}

interface RotationPanelProps {
  readonly rows: readonly RotationRow[];
}

export function RotationPanel({ rows }: RotationPanelProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.panel, { backgroundColor: colors.surface }]}>
      {rows.map((row, index) => (
        <View
          key={row.key}
          accessible
          accessibilityLabel={`${index + 1}, ${row.title}, ${row.detail}${row.value === null ? "" : `, ${row.value}`}`}
          style={[styles.row, { borderBottomColor: colors.line, borderBottomWidth: index === rows.length - 1 ? 0 : 1 }, row.next && { backgroundColor: colors.surface2 }]}
        >
          {row.next ? <View style={[styles.nextMark, { backgroundColor: colors.mark }]} /> : null}
          <Text style={[styles.position, { color: row.next ? colors.text : colors.text3 }]}>{index + 1}</Text>
          <SportIcon sport={row.sport} variant={row.next ? "filled" : "plain"} label={sports[row.sport].label} />
          <View style={styles.main}>
            <Text variant="bodyStrong" numberOfLines={1}>
              {row.title}
            </Text>
            <Text variant="small" tone="secondary" numberOfLines={1}>
              {row.detail}
            </Text>
          </View>
          {row.value === null ? null : (
            <Text variant={row.next ? "caption" : "label"} tone={row.next ? "primary" : "secondary"} style={row.next ? styles.nextLabel : undefined}>
              {row.value}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { marginTop: 8, borderRadius: radii.panel, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 10, paddingHorizontal: 14 },
  nextMark: { position: "absolute", left: 0, top: 0, bottom: 0, width: 3 },
  position: { width: 22, fontFamily: fonts.figure700, fontSize: 15, lineHeight: 18 },
  main: { flex: 1, minWidth: 0, gap: 3 },
  nextLabel: { fontFamily: fonts.text700 },
});
