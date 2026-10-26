import { Pressable, StyleSheet, TextInput, View } from "react-native";
import type { ReactNode } from "react";
import type { StyleProp, TextInputProps, ViewStyle } from "react-native";
import type { PainLevel } from "@obnixe/schema";
import { Icon } from "@/ui/icons/Icon";
import type { IconName } from "@/ui/icons/Icon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii, type as typeScale } from "@/ui/tokens";

interface IconButtonProps {
  readonly icon: IconName;
  readonly label: string;
  readonly onPress: () => void;
  readonly edge?: "start" | "end";
  readonly pressed?: boolean;
}

export function IconButton({ icon, label, onPress, edge, pressed: active = false }: IconButtonProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        edge === "start" && { marginLeft: -12 },
        edge === "end" && { marginRight: -12 },
        pressed && { backgroundColor: colors.surface },
      ]}
    >
      <Icon name={icon} color={active ? colors.text : colors.text2} />
    </Pressable>
  );
}

export interface ScaleOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
  readonly caption?: string;
}

interface ScaleProps<T extends string | number> {
  readonly label: string;
  readonly options: readonly ScaleOption<T>[];
  readonly value: T | null;
  readonly onChange: (value: T | null) => void;
  readonly target?: T;
  readonly words?: boolean;
  readonly optional?: boolean;
}

export function Scale<T extends string | number>({ label, options, value, onChange, target, words = false, optional = false }: ScaleProps<T>) {
  const { colors } = useTheme();
  return (
    <View style={styles.scale} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={option.caption === undefined ? option.label : `${option.label}, ${option.caption}`}
            onPress={() => onChange(selected && optional ? null : option.value)}
            style={({ pressed }) => [
              styles.scaleOption,
              selected
                ? { backgroundColor: colors.text }
                : { borderColor: colors.controlBorder, borderWidth: layout.borderControl, backgroundColor: pressed ? colors.surface : "transparent" },
            ]}
          >
            <Text
              tone={selected ? "inverse" : "primary"}
              style={words ? styles.scaleWord : styles.scaleFigure}
              numberOfLines={2}
              maxFontSizeMultiplier={1.3}
            >
              {option.label}
            </Text>
            {option.caption === undefined ? null : (
              <Text variant="eyebrow" tone={selected ? "inverse" : "secondary"} style={styles.scaleCaption} maxFontSizeMultiplier={1.3}>
                {option.caption}
              </Text>
            )}
            {option.value === target ? (
              <View style={[styles.target, { backgroundColor: selected ? colors.bg : colors.mark }]} />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export const painLevelLabels: Readonly<Record<PainLevel, string>> = { none: "Calme", discomfort: "Gêne", stop: "Arrêt" };

interface PainLevelsProps {
  readonly label: string;
  readonly value: PainLevel | null;
  readonly onChange: (value: PainLevel | null) => void;
  readonly levels?: readonly PainLevel[];
}

export function PainLevels({ label, value, onChange, levels = ["none", "discomfort", "stop"] }: PainLevelsProps) {
  const { colors } = useTheme();
  const fill = (level: PainLevel): { readonly background: string; readonly ink: string } => {
    switch (level) {
      case "none":
        return { background: colors.text, ink: colors.bg };
      case "discomfort":
        return { background: colors.warn, ink: colors.warnInk };
      case "stop":
        return { background: colors.stop, ink: colors.stopInk };
      default: {
        const unreachable: never = level;
        return unreachable;
      }
    }
  };
  return (
    <View style={styles.levels} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {levels.map((level) => {
        const selected = level === value;
        const selectedFill = fill(level);
        return (
          <Pressable
            key={level}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(selected ? null : level)}
            style={({ pressed }) => [
              styles.level,
              selected
                ? { backgroundColor: selectedFill.background }
                : { borderColor: colors.controlBorder, borderWidth: layout.borderControl, backgroundColor: pressed ? colors.surfacePress : "transparent" },
            ]}
          >
            <Text variant="label" style={selected ? { color: selectedFill.ink } : undefined}>
              {painLevelLabels[level]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

interface ZoneRowProps {
  readonly name: string;
  readonly detail?: string;
  readonly value: PainLevel | null;
  readonly onChange: (value: PainLevel | null) => void;
}

export function ZoneRow({ name, detail, value, onChange }: ZoneRowProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.zone, { borderTopColor: colors.line }]}>
      <View style={styles.zoneName}>
        <Text variant="bodyStrong">{name}</Text>
        {detail === undefined ? null : (
          <Text variant="caption" tone="secondary" style={styles.zoneDetail}>
            {detail}
          </Text>
        )}
      </View>
      <PainLevels label={name} value={value} onChange={onChange} />
    </View>
  );
}

interface QuestionProps {
  readonly title: string;
  readonly hint?: string;
  readonly children: ReactNode;
}

export function Question({ title, hint, children }: QuestionProps) {
  return (
    <View style={styles.question}>
      <View style={styles.questionHead}>
        <Text variant="bodyStrong">{title}</Text>
        {hint === undefined ? null : (
          <Text variant="caption" tone="secondary">
            {hint}
          </Text>
        )}
      </View>
      {children}
    </View>
  );
}

export interface ViewSwitchItem<T extends string> {
  readonly value: T;
  readonly label: string;
}

interface ViewSwitchProps<T extends string> {
  readonly items: readonly ViewSwitchItem<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}

export function ViewSwitch<T extends string>({ items, value, onChange }: ViewSwitchProps<T>) {
  const { colors } = useTheme();
  return (
    <View style={[styles.viewSwitch, { borderBottomColor: colors.line }]} accessibilityRole="tablist">
      {items.map((item) => {
        const current = item.value === value;
        return (
          <Pressable
            key={item.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: current }}
            onPress={() => onChange(item.value)}
            style={[styles.viewSwitchItem, current && { borderBottomColor: colors.text }]}
          >
            <Text tone={current ? "primary" : "secondary"} style={current ? styles.viewSwitchCurrent : styles.viewSwitchLabel}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

interface TextFieldProps extends Omit<TextInputProps, "style"> {
  readonly multiline?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}

export function TextField({ multiline = false, style, ...rest }: TextFieldProps) {
  const { colors } = useTheme();
  return (
    <TextInput
      {...rest}
      multiline={multiline}
      placeholderTextColor={colors.text3}
      selectionColor={colors.mark}
      style={[
        styles.textField,
        multiline && styles.textArea,
        { backgroundColor: colors.surface, borderColor: colors.controlBorder, color: colors.text },
        style,
      ]}
    />
  );
}

interface MenuItemProps {
  readonly label: string;
  readonly detail?: string;
  readonly leading?: ReactNode;
  readonly onPress: () => void;
  readonly destructive?: boolean;
}

export function MenuItem({ label, detail, leading, onPress, destructive = false }: MenuItemProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.menuItem, { borderTopColor: colors.line }, pressed && { backgroundColor: colors.surfacePress }]}
    >
      {leading}
      <View style={styles.menuText}>
        <Text style={[styles.menuLabel, destructive && { color: colors.stop }]}>{label}</Text>
        {detail === undefined ? null : (
          <Text variant="caption" tone="secondary" style={styles.menuDetail}>
            {detail}
          </Text>
        )}
      </View>
      <Icon name="chevron" color={colors.text3} />
    </Pressable>
  );
}

export interface ChoiceItem<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly primary?: boolean;
}

interface ChoicesProps<T extends string> {
  readonly items: readonly ChoiceItem<T>[];
  readonly onChoose: (value: T) => void;
}

export function Choices<T extends string>({ items, onChoose }: ChoicesProps<T>) {
  const { colors } = useTheme();
  return (
    <View style={styles.choices}>
      {items.map((item) => (
        <Pressable
          key={item.value}
          accessibilityRole="button"
          onPress={() => onChoose(item.value)}
          style={({ pressed }) => [
            styles.choice,
            item.primary === true
              ? { backgroundColor: colors.text }
              : { borderColor: colors.controlBorder, borderWidth: layout.borderControl, backgroundColor: pressed ? colors.surfacePress : "transparent" },
          ]}
        >
          <Text tone={item.primary === true ? "inverse" : "primary"} style={styles.choiceLabel}>
            {item.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

interface NumberPadProps {
  readonly value: string;
  readonly unit: string;
  readonly placeholder: string;
  readonly decimals: number;
  readonly maxLength?: number;
  readonly warning?: string;
  readonly onChange: (value: string) => void;
}

const padKeys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "decimal", "0", "backspace"] as const;
type PadKey = (typeof padKeys)[number];

export function NumberPad({ value, unit, placeholder, decimals, maxLength = 6, warning, onChange }: NumberPadProps) {
  const { colors, name } = useTheme();
  const press = (key: PadKey): void => {
    switch (key) {
      case "backspace":
        onChange(value.slice(0, -1));
        return;
      case "decimal":
        if (decimals === 0 || value.includes(",")) return;
        onChange(value === "" ? "0," : `${value},`);
        return;
      default: {
        if (value.length >= maxLength) return;
        const [, fraction] = value.split(",");
        if (fraction !== undefined && fraction.length >= decimals) return;
        onChange(value === "0" ? key : `${value}${key}`);
      }
    }
  };
  return (
    <View>
      <View style={styles.padDisplay} accessibilityLiveRegion="polite">
        <Text variant="display" tone={value === "" ? "tertiary" : "primary"}>
          {value === "" ? placeholder : value}
        </Text>
        <Text variant="label" tone="secondary">
          {unit}
        </Text>
      </View>
      {warning === undefined ? null : (
        <View style={styles.padWarning}>
          <View style={[styles.padWarningMark, { borderColor: colors.warn }]} />
          <Text variant="small" style={styles.padWarningText}>
            {warning}
          </Text>
        </View>
      )}
      <View style={styles.pad}>
        {padKeys.map((key) => {
          const disabled = key === "decimal" && decimals === 0;
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={key === "backspace" ? "Effacer" : key === "decimal" ? "Virgule" : key}
              disabled={disabled}
              onPress={() => press(key)}
              style={({ pressed }) => [
                styles.padKey,
                { backgroundColor: pressed ? colors.surfacePress : name === "dark" ? colors.surface2 : colors.surface },
                disabled && styles.padKeyHidden,
              ]}
            >
              {key === "backspace" ? <Icon name="backspace" size={24} /> : <Text style={styles.padKeyLabel}>{key === "decimal" ? "," : key}</Text>}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function parsePadValue(value: string): number | null {
  if (value === "" || value === "0,") return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

interface PanelProps {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}

export function Panel({ children, style }: PanelProps) {
  const { colors } = useTheme();
  return <View style={[styles.panel, { backgroundColor: colors.surface }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  iconButton: { width: 44, height: 44, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
  scale: { flexDirection: "row", gap: 6 },
  scaleOption: {
    flex: 1,
    minHeight: 56,
    paddingVertical: 6,
    paddingHorizontal: 2,
    borderRadius: radii.control,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  scaleFigure: { fontFamily: fonts.figure700, fontSize: 19, lineHeight: 21, textAlign: "center" },
  scaleWord: { fontFamily: fonts.text600, fontSize: 15, lineHeight: 17, textAlign: "center" },
  scaleCaption: { fontFamily: fonts.text600, fontSize: 12, lineHeight: 13, letterSpacing: 0, textTransform: "none" },
  target: { position: "absolute", top: 7, right: 7, width: 6, height: 6, borderRadius: 3 },
  levels: { flexDirection: "row", gap: 6 },
  level: { width: 76, minHeight: 48, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
  zone: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, borderTopWidth: 1 },
  zoneName: { flex: 1, gap: 2 },
  zoneDetail: { fontFamily: fonts.text500 },
  question: { gap: 8, marginTop: 20 },
  questionHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 },
  viewSwitch: { flexDirection: "row", gap: 22, marginTop: 6, borderBottomWidth: 1 },
  viewSwitchItem: { minHeight: 44, minWidth: 44, paddingHorizontal: 4, justifyContent: "center", borderBottomWidth: 2, borderBottomColor: "transparent", marginBottom: -1 },
  viewSwitchLabel: { fontFamily: fonts.text600, fontSize: 16 },
  viewSwitchCurrent: { fontFamily: fonts.text700, fontSize: 16 },
  textField: { ...typeScale.body, minHeight: 48, paddingHorizontal: 14, paddingVertical: 12, borderRadius: radii.control, borderWidth: layout.borderControl },
  textArea: { minHeight: 96, textAlignVertical: "top" },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, borderTopWidth: 1 },
  menuText: { flex: 1 },
  menuLabel: { fontFamily: fonts.text600, fontSize: 17, lineHeight: 22 },
  menuDetail: { fontFamily: fonts.text500 },
  choices: { gap: 8, marginTop: 16 },
  choice: { minHeight: 56, paddingHorizontal: 16, borderRadius: radii.panel, justifyContent: "center" },
  choiceLabel: { fontFamily: fonts.text600, fontSize: 16 },
  padDisplay: { flexDirection: "row", alignItems: "baseline", justifyContent: "center", gap: 8, paddingTop: 6, paddingBottom: 8 },
  padWarning: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 10 },
  padWarningMark: { width: 8, height: 8, borderRadius: 4, borderWidth: 2 },
  padWarningText: { fontFamily: fonts.text600 },
  pad: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 },
  padKey: { width: "32%", flexGrow: 1, height: 60, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
  padKeyHidden: { opacity: 0 },
  padKeyLabel: { fontFamily: fonts.figure700, fontSize: 26, lineHeight: 28 },
  panel: { borderRadius: radii.panel, paddingVertical: 14, paddingHorizontal: 16 },
});
