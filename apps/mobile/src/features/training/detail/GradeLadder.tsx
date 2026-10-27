import { StyleSheet, View } from "react-native";
import { parseGrade, worstLevel } from "@obnixe/core";
import type { PainReport, SessionItem } from "@obnixe/schema";
import { capitalize, plural } from "@/format/labels";
import { climbItemText } from "@/features/training/sessionText";
import { PainMark } from "@/ui/Controls";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import type { Palette } from "@/ui/tokens";
import { fonts, radii, wash } from "@/ui/tokens";

type ClimbResult = "flash" | "sent" | "project";

const resultLabels: Readonly<Record<ClimbResult, string>> = { flash: "Flash", sent: "Enchaîné", project: "Pas encore" };

const resultOrder: readonly ClimbResult[] = ["flash", "sent", "project"];

function climbResult(item: SessionItem): ClimbResult {
  const result = item.values.result;
  return result === "flash" || result === "sent" ? result : "project";
}

function attemptsOf(item: SessionItem): number {
  return typeof item.values.attempts === "number" ? item.values.attempts : 1;
}

interface ResultMarkStyle {
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly borderStyle: "solid" | "dashed";
  readonly ink: string;
}

function resultMark(result: ClimbResult, colors: Palette): ResultMarkStyle {
  const tone = colors.sport.climb;
  switch (result) {
    case "flash":
      return { backgroundColor: tone, borderColor: tone, borderStyle: "solid", ink: colors.bg };
    case "sent":
      return { backgroundColor: wash(tone, 0.22), borderColor: tone, borderStyle: "solid", ink: colors.text };
    case "project":
      return { backgroundColor: "transparent", borderColor: colors.controlBorder, borderStyle: "dashed", ink: colors.text2 };
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

interface ResultCellProps {
  readonly result: ClimbResult;
  readonly attempts: number | null;
  readonly small?: boolean;
}

function ResultCell({ result, attempts, small = false }: ResultCellProps) {
  const { colors } = useTheme();
  const mark = resultMark(result, colors);
  return (
    <View style={[styles.cell, small && styles.cellSmall, { backgroundColor: mark.backgroundColor, borderColor: mark.borderColor, borderStyle: mark.borderStyle }]}>
      {attempts === null || result === "flash" ? null : <Text style={[styles.cellText, { color: mark.ink }]}>{attempts}</Text>}
    </View>
  );
}

interface LadderRung {
  readonly label: string;
  readonly rank: number;
  readonly items: readonly SessionItem[];
}

function rungs(items: readonly SessionItem[]): readonly LadderRung[] {
  const byLabel = new Map<string, LadderRung>();
  for (const item of items) {
    const grade = parseGrade(item.values.grade);
    const label = grade?.label ?? "–";
    const existing = byLabel.get(label);
    byLabel.set(label, { label, rank: grade?.index ?? -1, items: [...(existing?.items ?? []), item] });
  }
  return [...byLabel.values()].sort((left, right) => right.rank - left.rank);
}

function rungText(rung: LadderRung): string {
  return resultOrder
    .flatMap((result) => {
      const count = rung.items.filter((item) => climbResult(item) === result).length;
      return count === 0 ? [] : [`${count} ${resultLabels[result].toLowerCase()}`];
    })
    .join(", ");
}

interface GradeLadderProps {
  readonly items: readonly SessionItem[];
  readonly pains: readonly PainReport[];
  readonly itemWord: { readonly singular: string; readonly plural: string };
}

export function GradeLadder({ items, pains, itemWord }: GradeLadderProps) {
  const { colors } = useTheme();
  const ladder = rungs(items);
  const counts = resultOrder.map((result) => ({ result, count: items.filter((item) => climbResult(item) === result).length })).filter((entry) => entry.count > 0);
  return (
    <View>
      <View style={[styles.ladder, { backgroundColor: colors.surface }]}>
        {ladder.map((rung) => (
          <View key={rung.label} style={styles.rung} accessible accessibilityLabel={`${rung.label} : ${rungText(rung)}`}>
            <Text style={styles.rungGrade}>{rung.label}</Text>
            <View style={styles.cells}>
              {rung.items.map((item) => (
                <ResultCell key={item.id} result={climbResult(item)} attempts={attemptsOf(item)} />
              ))}
            </View>
          </View>
        ))}
        <View style={[styles.legend, { borderTopColor: colors.line }]}>
          {counts.map((entry) => (
            <View key={entry.result} style={styles.legendPart}>
              <ResultCell result={entry.result} attempts={null} small />
              <Text variant="small" tone="secondary">
                {resultLabels[entry.result]} <Text style={styles.legendCount}>{entry.count}</Text>
              </Text>
            </View>
          ))}
        </View>
      </View>
      {items.map((item, index) => {
        const text = climbItemText(item);
        const level = worstLevel(pains.filter((pain) => pain.sessionItemId === item.id).map((pain) => pain.level));
        const result = climbResult(item);
        return (
          <View
            key={item.id}
            accessible
            accessibilityLabel={`${capitalize(itemWord.singular)} ${index + 1}, ${text.grade}${text.style === "" ? "" : `, ${text.style}`}, ${text.result}`}
            style={[styles.item, { borderBottomColor: colors.line, borderBottomWidth: index === items.length - 1 ? 0 : 1 }]}
          >
            <View style={styles.itemIndex}>
              <Text style={styles.itemIndexText} tone="tertiary">
                {index + 1}
              </Text>
              {level === null ? null : <PainMark level={level} />}
            </View>
            <Text style={styles.itemGrade}>{text.grade}</Text>
            <Text variant="small" tone="secondary" style={styles.itemStyle} numberOfLines={1}>
              {text.style}
            </Text>
            <View style={styles.itemResult}>
              <ResultCell result={result} attempts={null} small />
              <Text style={styles.itemResultText} tone={result === "project" ? "secondary" : "primary"}>
                {result === "sent" && attemptsOf(item) > 1 ? plural(attemptsOf(item), "essai") : text.result}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  ladder: { marginTop: 10, marginBottom: 6, borderRadius: radii.panel, paddingHorizontal: 14, paddingTop: 8 },
  rung: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 36 },
  rungGrade: { width: 40, fontFamily: fonts.figure800, fontSize: 20, lineHeight: 22 },
  cells: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  cell: { width: 22, height: 22, borderRadius: 5, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  cellSmall: { width: 14, height: 14, borderRadius: 4 },
  cellText: { fontFamily: fonts.figure700, fontSize: 12, lineHeight: 14 },
  legend: { flexDirection: "row", flexWrap: "wrap", columnGap: 16, rowGap: 6, marginTop: 6, paddingVertical: 10, borderTopWidth: 1 },
  legendPart: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendCount: { fontFamily: fonts.figure700, fontSize: 15 },
  item: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, paddingVertical: 8 },
  itemIndex: { width: 34, flexDirection: "row", alignItems: "center", gap: 6 },
  itemIndexText: { fontFamily: fonts.figure700, fontSize: 16, lineHeight: 18 },
  itemGrade: { width: 44, fontFamily: fonts.figure700, fontSize: 20, lineHeight: 22 },
  itemStyle: { flex: 1, minWidth: 0 },
  itemResult: { flexDirection: "row", alignItems: "center", gap: 8 },
  itemResultText: { fontFamily: fonts.text600, fontSize: 15 },
});
