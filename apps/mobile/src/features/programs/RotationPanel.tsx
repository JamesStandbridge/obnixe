import { StyleSheet, View } from "react-native";
import { sports } from "@obnixe/schema";
import type { SportKey } from "@obnixe/schema";
import { lowerFirst } from "@/format/labels";
import { SportIcon } from "@/ui/icons/SportIcon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii, wash } from "@/ui/tokens";

export interface RotationRow {
  readonly key: string;
  readonly sport: SportKey;
  readonly title: string;
  readonly detail: string;
  readonly next: boolean;
  readonly value: string | null;
}

interface RotationProps {
  readonly rows: readonly RotationRow[];
}

interface SportCount {
  readonly sport: SportKey;
  readonly count: number;
}

function composition(rows: readonly RotationRow[]): readonly SportCount[] {
  const counts = new Map<SportKey, number>();
  for (const row of rows) counts.set(row.sport, (counts.get(row.sport) ?? 0) + 1);
  return [...counts].map(([sport, count]) => ({ sport, count })).sort((left, right) => right.count - left.count);
}

export function RotationTrack({ rows }: RotationProps) {
  const { colors } = useTheme();
  const parts = composition(rows);
  const nextIndex = rows.findIndex((row) => row.next);
  return (
    <View style={styles.trackBlock}>
      <View
        style={styles.track}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`Rotation de ${rows.length} séances${nextIndex === -1 ? "" : `, prochaine : ${nextIndex + 1}, ${rows[nextIndex]?.title ?? ""}`}`}
      >
        {rows.map((row, index) => {
          const tone = colors.sport[row.sport];
          return (
            <View key={row.key} style={styles.segment}>
              <View style={[styles.segmentBar, row.next ? { backgroundColor: tone, height: 10 } : { backgroundColor: wash(tone, 0.42) }]} />
              <Text style={[styles.segmentIndex, { color: row.next ? colors.text : colors.text3 }, row.next && styles.segmentIndexNext]}>{index + 1}</Text>
            </View>
          );
        })}
      </View>
      <View style={styles.composition}>
        {parts.map((part) => (
          <View key={part.sport} style={styles.compositionPart}>
            <View style={[styles.dot, { backgroundColor: colors.sport[part.sport] }]} />
            <Text variant="small">
              <Text style={styles.compositionCount}>{part.count}</Text> {lowerFirst(sports[part.sport].label)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export function RotationPanel({ rows }: RotationProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.panel, { backgroundColor: colors.surface }]}>
      {rows.map((row, index) => {
        const tone = colors.sport[row.sport];
        return (
          <View
            key={row.key}
            accessible
            accessibilityLabel={`${index + 1}, ${row.title}, ${row.detail}${row.value === null ? "" : `, ${row.value}`}`}
            style={[styles.row, { borderBottomColor: colors.line, borderBottomWidth: index === rows.length - 1 ? 0 : 1 }, row.next && { backgroundColor: colors.surface2 }]}
          >
            {row.next ? <View style={[styles.nextMark, { backgroundColor: tone }]} /> : null}
            <Text style={[styles.position, { color: row.next ? colors.text : colors.text3 }]}>{index + 1}</Text>
            <SportIcon sport={row.sport} variant="badge" label={sports[row.sport].label} />
            <View style={styles.main}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {row.title}
              </Text>
              <Text variant="small" tone="secondary" numberOfLines={1}>
                {row.detail}
              </Text>
            </View>
            {row.value === null ? null : row.next ? (
              <View style={[styles.nextTag, { backgroundColor: colors.actBg }]}>
                <Text variant="caption" tone="act" style={styles.nextLabel}>
                  {row.value}
                </Text>
              </View>
            ) : (
              <Text variant="caption" tone="tertiary">
                {row.value}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  trackBlock: { marginTop: 14, gap: 10 },
  track: { flexDirection: "row", gap: 3 },
  segment: { flex: 1, gap: 5 },
  segmentBar: { height: 6, borderRadius: 2, marginTop: "auto" },
  segmentIndex: { fontFamily: fonts.figure600, fontSize: 12, lineHeight: 13, textAlign: "center" },
  segmentIndexNext: { fontFamily: fonts.figure800 },
  composition: { flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4 },
  compositionPart: { flexDirection: "row", alignItems: "center", gap: 6 },
  compositionCount: { fontFamily: fonts.figure700, fontSize: 15 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  panel: { marginTop: 14, borderRadius: radii.panel, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, paddingVertical: 10, paddingHorizontal: 14 },
  nextMark: { position: "absolute", left: 0, top: 0, bottom: 0, width: 3 },
  position: { width: 16, fontFamily: fonts.figure700, fontSize: 15, lineHeight: 18 },
  main: { flex: 1, minWidth: 0, gap: 3 },
  nextTag: { borderRadius: radii.tag, paddingHorizontal: 6, paddingVertical: 3 },
  nextLabel: { fontFamily: fonts.text700 },
});
