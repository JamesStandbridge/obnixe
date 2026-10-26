import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PainLevel, SportKey } from "@obnixe/schema";
import { PainMark, Switch } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import { SportIcon } from "@/ui/icons/SportIcon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";

export const bottomPanelHeight = 86;

interface BottomPanelProps {
  readonly children: ReactNode;
}

export function BottomPanel({ children }: BottomPanelProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return <View style={[styles.bottomPanel, { backgroundColor: colors.bg, borderTopColor: colors.line, paddingBottom: insets.bottom + 12 }]}>{children}</View>;
}

interface FigureProps {
  readonly value: string;
  readonly label: ReactNode;
  readonly suggested?: boolean;
  readonly size?: number;
  readonly onPress?: () => void;
  readonly accessibilityLabel: string;
}

export function Figure({ value, label, suggested = false, size = 84, onPress, accessibilityLabel }: FigureProps) {
  const { colors } = useTheme();
  const [integer, decimal] = value.split(",");
  const strongStyle = { fontSize: size, lineHeight: Math.round(size * 0.92), color: suggested ? colors.text3 : colors.text };
  const content = (
    <>
      <View style={styles.figureValue}>
        <Text maxFontSizeMultiplier={1} numberOfLines={1} adjustsFontSizeToFit style={[styles.figureStrong, strongStyle]}>
          {integer}
        </Text>
        {decimal === undefined ? null : (
          <Text maxFontSizeMultiplier={1} style={[styles.figureDecimal, { fontSize: Math.round(size * 0.55), lineHeight: Math.round(size * 0.6), color: strongStyle.color }]}>
            ,{decimal}
          </Text>
        )}
      </View>
      {typeof label === "string" ? (
        <Text style={styles.figureLabel} tone="secondary" maxFontSizeMultiplier={1.3}>
          {label}
        </Text>
      ) : (
        label
      )}
    </>
  );
  if (onPress === undefined) {
    return (
      <View style={styles.figure} accessible accessibilityLabel={accessibilityLabel}>
        {content}
      </View>
    );
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} style={({ pressed }) => [styles.figure, pressed && { backgroundColor: colors.surface }]}>
      {content}
    </Pressable>
  );
}

interface FigureRowProps {
  readonly left: ReactNode;
  readonly right: ReactNode;
  readonly rightWeight?: number;
}

export function FigureRow({ left, right, rightWeight = 1 }: FigureRowProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.figureRow}>
      {left === null ? null : (
        <>
          <View style={styles.figureCell}>{left}</View>
          <Text style={[styles.times, { color: colors.text3 }]} accessibilityElementsHidden importantForAccessibility="no">
            ·
          </Text>
        </>
      )}
      <View style={[styles.figureCell, { flex: rightWeight }]}>{right}</View>
    </View>
  );
}

interface ComparisonProps {
  readonly strong: string;
  readonly rest?: string;
}

export function Comparison({ strong, rest }: ComparisonProps) {
  return (
    <Text variant="small" tone="secondary" numberOfLines={1} style={styles.comparison}>
      <Text style={styles.comparisonStrong}>{strong}</Text>
      {rest === undefined || rest === "" ? "" : ` ${rest}`}
    </Text>
  );
}

interface PlainButtonProps {
  readonly label: string;
  readonly onPress: () => void;
}

export function OtherZoneButton({ label, onPress }: PlainButtonProps) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.otherZone, { borderTopColor: colors.line }, pressed && { backgroundColor: colors.surface }]}>
      <Text variant="label" tone="secondary">
        {label}
      </Text>
    </Pressable>
  );
}

interface ChoiceButtonProps {
  readonly label: string;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}

export function ChoiceButton({ label, destructive = false, onPress }: ChoiceButtonProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.choice, { borderColor: colors.controlBorder, backgroundColor: pressed ? colors.surfacePress : "transparent" }]}
    >
      <Text style={[styles.choiceLabel, destructive && { color: colors.stop }]}>{label}</Text>
    </Pressable>
  );
}

interface DetailRowProps {
  readonly title: string;
  readonly value: string | null;
  readonly unit?: string;
  readonly onPress: () => void;
  readonly last?: boolean;
}

export function DetailRow({ title, value, unit, onPress, last = false }: DetailRowProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value === null ? `${title}, ajouter` : `${title}, ${value}${unit === undefined || unit === "" ? "" : ` ${unit}`}`}
      onPress={onPress}
      style={({ pressed }) => [styles.detailRow, { borderBottomColor: colors.line, borderBottomWidth: last ? 0 : 1 }, pressed && { backgroundColor: colors.surface }]}
    >
      <Text variant="bodyStrong" numberOfLines={1} style={styles.detailTitle}>
        {title}
      </Text>
      {value === null ? (
        <Text variant="label" tone="tertiary">
          Ajouter
        </Text>
      ) : (
        <Text variant="value" numberOfLines={1} style={styles.detailValue}>
          {value}
          {unit === undefined || unit === "" ? null : (
            <Text variant="caption" tone="secondary">
              {` ${unit}`}
            </Text>
          )}
        </Text>
      )}
      <Icon name="chevron" color={colors.text3} />
    </Pressable>
  );
}

interface SwitchRowProps {
  readonly title: string;
  readonly detail?: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}

export function SwitchRow({ title, detail, value, onChange }: SwitchRowProps) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchText}>
        <Text variant="bodyStrong">{title}</Text>
        {detail === undefined ? null : (
          <Text variant="small" tone="secondary">
            {detail}
          </Text>
        )}
      </View>
      <Switch label={title} value={value} onChange={onChange} />
    </View>
  );
}

interface GradeGridProps {
  readonly grades: readonly string[];
  readonly selected: string | null;
  readonly onSelect: (grade: string) => void;
}

export function GradeGrid({ grades, selected, onSelect }: GradeGridProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.grades} accessibilityRole="radiogroup">
      {grades.map((grade) => {
        const current = grade === selected;
        return (
          <Pressable
            key={grade}
            accessibilityRole="radio"
            aria-checked={current}
            onPress={() => onSelect(grade)}
            style={({ pressed }) => [
              styles.grade,
              current ? { backgroundColor: colors.text } : { borderColor: colors.controlBorder, borderWidth: layout.borderControl, backgroundColor: pressed ? colors.surfacePress : "transparent" },
            ]}
          >
            <Text style={styles.gradeLabel} tone={current ? "inverse" : "primary"} maxFontSizeMultiplier={1.2}>
              {grade}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export interface ChipOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
}

interface ChipsProps<T extends string> {
  readonly label: string;
  readonly options: readonly ChipOption<T>[];
  readonly selected: readonly T[];
  readonly multiple: boolean;
  readonly compact?: boolean;
  readonly onToggle: (value: T) => void;
}

export function Chips<T extends string>({ label, options, selected, multiple, compact = false, onToggle }: ChipsProps<T>) {
  const { colors } = useTheme();
  return (
    <View style={styles.chips} accessibilityRole={multiple ? undefined : "radiogroup"} accessibilityLabel={label}>
      {options.map((option) => {
        const on = selected.includes(option.value);
        const disabled = option.disabled === true;
        return (
          <Pressable
            key={option.value}
            accessibilityRole={multiple ? "checkbox" : "radio"}
            aria-checked={on}
            aria-disabled={disabled}
            disabled={disabled}
            onPress={() => onToggle(option.value)}
            style={({ pressed }) => [
              styles.chip,
              compact && styles.chipCompact,
              { borderColor: on ? colors.text : colors.controlBorder, borderWidth: on ? 2 : layout.borderControl, backgroundColor: on || pressed ? colors.surface : "transparent" },
              disabled && styles.disabled,
            ]}
          >
            <Text variant="label" tone={on ? "primary" : "secondary"} style={on ? styles.chipOn : undefined} numberOfLines={2}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export interface SportChoice {
  readonly key: SportKey | "catalogue";
  readonly label: string;
}

interface SportStripProps {
  readonly items: readonly SportChoice[];
  readonly value: SportKey;
  readonly onChange: (value: SportKey | "catalogue") => void;
}

export function SportStrip({ items, value, onChange }: SportStripProps) {
  const { colors } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip} contentContainerStyle={styles.stripContent} accessibilityRole="radiogroup" accessibilityLabel="Sport">
      {items.map((item) => {
        const on = item.key === value;
        return (
          <Pressable
            key={item.key}
            accessibilityRole="radio"
            aria-checked={on}
            accessibilityLabel={item.label}
            onPress={() => onChange(item.key)}
            style={({ pressed }) => [
              styles.stripItem,
              { borderColor: on ? colors.text : colors.controlBorder, borderWidth: on ? 2 : layout.borderControl, backgroundColor: on || pressed ? colors.surface : "transparent" },
            ]}
          >
            <SportIcon sport={item.key === "catalogue" ? "new" : item.key} variant="inline" color={on ? colors.text : colors.text2} />
            <Text variant="label" tone={on ? "primary" : "secondary"} style={on ? styles.chipOn : undefined}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

interface PainIndicatorProps {
  readonly level: PainLevel | null;
}

export function PainIndicator({ level }: PainIndicatorProps) {
  if (level === null || level === "none") return null;
  return <PainMark level={level} />;
}

const styles = StyleSheet.create({
  bottomPanel: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopWidth: 1, paddingTop: 10, paddingHorizontal: layout.gutter, gap: 10 },
  figure: { alignItems: "center", gap: 6, paddingTop: 6, paddingBottom: 8, borderRadius: radii.panel },
  figureValue: { flexDirection: "row", alignItems: "flex-start", maxWidth: "100%" },
  figureStrong: { fontFamily: fonts.figure800, letterSpacing: -1.5, flexShrink: 1 },
  figureDecimal: { fontFamily: fonts.figure700, marginLeft: 1 },
  figureLabel: { fontFamily: fonts.text600, fontSize: 13, lineHeight: 15, letterSpacing: 0.5, textTransform: "uppercase" },
  figureRow: { flexDirection: "row", alignItems: "flex-end" },
  figureCell: { flex: 1, minWidth: 0 },
  times: { width: 20, textAlign: "center", fontFamily: fonts.figure600, fontSize: 36, lineHeight: 40, paddingBottom: 30 },
  comparison: { paddingHorizontal: 4 },
  comparisonStrong: { fontFamily: fonts.text600, fontSize: 15 },
  otherZone: { minHeight: 48, borderTopWidth: 1, alignItems: "center", justifyContent: "center" },
  choice: { minHeight: 56, paddingHorizontal: 16, borderRadius: radii.panel, borderWidth: layout.borderControl, justifyContent: "center" },
  choiceLabel: { fontFamily: fonts.text600, fontSize: 16, lineHeight: 20 },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 10 },
  detailTitle: { flex: 1 },
  detailValue: { flexShrink: 1, textAlign: "right" },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 64, paddingVertical: 10 },
  switchText: { flex: 1, gap: 3 },
  grades: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 12 },
  grade: { width: "23.5%", flexGrow: 1, height: 52, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
  gradeLabel: { fontFamily: fonts.figure700, fontSize: 20, lineHeight: 22 },
  chips: { flexDirection: "row", gap: 6 },
  chip: { flex: 1, minHeight: 48, paddingVertical: 6, paddingHorizontal: 6, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
  chipCompact: { minHeight: 44 },
  chipOn: { fontFamily: fonts.text700 },
  disabled: { opacity: 0.4 },
  strip: { marginHorizontal: -layout.gutter, flexGrow: 0 },
  stripContent: { paddingHorizontal: layout.gutter, gap: 6 },
  stripItem: { minHeight: 48, paddingHorizontal: 16, borderRadius: radii.control, flexDirection: "row", alignItems: "center", gap: 6 },
});
