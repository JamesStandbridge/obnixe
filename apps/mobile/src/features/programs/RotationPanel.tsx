import { StyleSheet, View } from "react-native";
import type { ViewStyle } from "react-native";
import { sports } from "@obnixe/schema";
import type { SportKey } from "@obnixe/schema";
import { lowerFirst, plural } from "@/format/labels";
import { Icon } from "@/ui/icons/Icon";
import { SportIcon } from "@/ui/icons/SportIcon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii, wash } from "@/ui/tokens";

export type RotationState = "done" | "skipped" | "next" | "pending";

export interface RotationRow {
  readonly key: string;
  readonly sport: SportKey;
  readonly title: string;
  readonly detail: string;
  readonly state: RotationState;
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

function isChecked(state: RotationState): boolean {
  switch (state) {
    case "done":
    case "skipped":
      return true;
    case "next":
    case "pending":
      return false;
    default: {
      const unreachable: never = state;
      throw new Error(`Unhandled rotation state ${String(unreachable)}`);
    }
  }
}

function segmentStyle(state: RotationState, tone: string): ViewStyle {
  switch (state) {
    case "done":
      return { backgroundColor: tone };
    case "skipped":
      return { backgroundColor: wash(tone, 0.42) };
    case "next":
      return { backgroundColor: tone, height: 10 };
    case "pending":
      return { borderWidth: 1.5, borderColor: wash(tone, 0.6) };
    default: {
      const unreachable: never = state;
      throw new Error(`Unhandled rotation state ${String(unreachable)}`);
    }
  }
}

function stateWord(state: RotationState): string {
  switch (state) {
    case "done":
      return "faite";
    case "skipped":
      return "passée";
    case "next":
      return "prochaine";
    case "pending":
      return "à faire";
    default: {
      const unreachable: never = state;
      throw new Error(`Unhandled rotation state ${String(unreachable)}`);
    }
  }
}

interface PositionProps {
  readonly state: RotationState;
  readonly index: number;
  readonly tone: string;
  readonly size: number;
}

function Position({ state, index, tone, size }: PositionProps) {
  const { colors } = useTheme();
  if (state === "done") return <Icon name="check" size={size} color={tone} />;
  return (
    <Text style={[styles.positionText, { fontSize: size - 2, lineHeight: size, color: state === "next" ? colors.text : colors.text3 }, state === "next" && styles.positionNext, state === "skipped" && styles.positionSkipped]}>
      {index + 1}
    </Text>
  );
}

export function RotationTrack({ rows }: RotationProps) {
  const { colors } = useTheme();
  const parts = composition(rows);
  const nextIndex = rows.findIndex((row) => row.state === "next");
  const checked = rows.filter((row) => isChecked(row.state)).length;
  return (
    <View style={styles.trackBlock}>
      <View
        style={styles.track}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`Rotation de ${rows.length} séances, ${checked} sur ${rows.length} dans ce cycle${nextIndex === -1 ? "" : `, prochaine : ${nextIndex + 1}, ${rows[nextIndex]?.title ?? ""}`}`}
      >
        {rows.map((row, index) => (
          <View key={row.key} style={styles.segment}>
            <View style={[styles.segmentBar, segmentStyle(row.state, colors.sport[row.sport])]} />
            <View style={styles.segmentIndex}>
              <Position state={row.state} index={index} tone={colors.sport[row.sport]} size={14} />
            </View>
          </View>
        ))}
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
        <Text variant="small" tone="secondary" style={styles.cycleCount}>
          {`${plural(checked, "faite", "faites")} sur ${rows.length}`}
        </Text>
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
        const next = row.state === "next";
        return (
          <View
            key={row.key}
            accessible
            accessibilityLabel={`${index + 1}, ${row.title}, ${row.detail}, ${stateWord(row.state)}${row.value === null || next ? "" : `, ${row.value}`}`}
            style={[styles.row, { borderBottomColor: colors.line, borderBottomWidth: index === rows.length - 1 ? 0 : 1 }, next && { backgroundColor: colors.surface2 }]}
          >
            {next ? <View style={[styles.nextMark, { backgroundColor: tone }]} /> : null}
            <View style={styles.position}>
              <Position state={row.state} index={index} tone={tone} size={17} />
            </View>
            <SportIcon sport={row.sport} variant="badge" label={sports[row.sport].label} />
            <View style={styles.main}>
              <Text variant="bodyStrong" tone={isChecked(row.state) ? "secondary" : "primary"} numberOfLines={1}>
                {row.title}
              </Text>
              <Text variant="small" tone="secondary" numberOfLines={1}>
                {row.detail}
              </Text>
            </View>
            {row.value === null ? null : next ? (
              <View style={[styles.nextTag, { backgroundColor: colors.actBg }]}>
                <Text variant="caption" tone="act" style={styles.nextLabel}>
                  {row.value}
                </Text>
              </View>
            ) : (
              <Text variant="caption" tone={row.state === "done" ? "secondary" : "tertiary"} style={row.state === "done" ? styles.doneLabel : undefined}>
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
  segmentIndex: { height: 14, alignItems: "center", justifyContent: "center" },
  positionText: { fontFamily: fonts.figure600, textAlign: "center" },
  positionNext: { fontFamily: fonts.figure800 },
  positionSkipped: { textDecorationLine: "line-through" },
  composition: { flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4 },
  compositionPart: { flexDirection: "row", alignItems: "center", gap: 6 },
  compositionCount: { fontFamily: fonts.figure700, fontSize: 15 },
  cycleCount: { marginLeft: "auto" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  panel: { marginTop: 14, borderRadius: radii.panel, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, paddingVertical: 10, paddingHorizontal: 14 },
  nextMark: { position: "absolute", left: 0, top: 0, bottom: 0, width: 3 },
  position: { width: 16, alignItems: "center" },
  main: { flex: 1, minWidth: 0, gap: 3 },
  nextTag: { borderRadius: radii.tag, paddingHorizontal: 6, paddingVertical: 3 },
  nextLabel: { fontFamily: fonts.text700 },
  doneLabel: { fontFamily: fonts.text600 },
});
