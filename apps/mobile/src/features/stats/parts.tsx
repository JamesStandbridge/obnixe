import { Fragment } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { ReactNode } from "react";
import { router } from "expo-router";
import Svg from "react-native-svg";
import { sports } from "@obnixe/schema";
import type { SportKey } from "@obnixe/schema";
import type { ReportedPainLevel } from "@obnixe/core";
import { PainMark, Tag } from "@/ui/Controls";
import { sportGlyphs } from "@/ui/icons/sportGlyphs";
import type { SportGlyphKey } from "@/ui/icons/sportGlyphs";
import { AppBar } from "@/ui/Layout";
import { ViewSwitch } from "@/ui/Inputs";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";

function glyphKey(sport: SportKey): SportGlyphKey {
  const icon = sports[sport].icon;
  return icon in sportGlyphs ? (icon as SportGlyphKey) : "other";
}

interface SmallSportIconProps {
  readonly sport: SportKey;
  readonly color: string;
  readonly size: number;
}

export function SmallSportIcon({ sport, color, size }: SmallSportIconProps) {
  const glyph = sportGlyphs[glyphKey(sport)];
  return (
    <View style={{ width: size + 2, height: size + 2, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} viewBox={glyph.viewBox}>
        {glyph.render(color, color)}
      </Svg>
    </View>
  );
}

export type DetailPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "pain"; readonly level: ReportedPainLevel; readonly text: string }
  | { readonly kind: "tag"; readonly label: string };

interface DetailLineProps {
  readonly parts: readonly DetailPart[];
}

export function DetailLine({ parts }: DetailLineProps) {
  return (
    <View style={styles.detail}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <Text variant="small" tone="secondary">
              ·
            </Text>
          ) : null}
          <DetailPiece part={part} />
        </Fragment>
      ))}
    </View>
  );
}

function DetailPiece({ part }: { readonly part: DetailPart }) {
  switch (part.kind) {
    case "text":
      return (
        <Text variant="small" tone="secondary">
          {part.text}
        </Text>
      );
    case "pain":
      return (
        <View style={styles.pain}>
          <PainMark level={part.level} />
          <Text variant="small" tone="secondary">
            {part.text}
          </Text>
        </View>
      );
    case "tag":
      return <Tag label={part.label} />;
    default: {
      const unreachable: never = part;
      return unreachable;
    }
  }
}

export interface ChipOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

interface FilterChipsProps<T extends string> {
  readonly label: string;
  readonly options: readonly ChipOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}

export function FilterChips<T extends string>({ label, options, value, onChange }: FilterChipsProps<T>) {
  const { colors } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.chipsScroll}
      contentContainerStyle={styles.chips}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.chip,
              {
                borderColor: selected ? colors.text : colors.controlBorder,
                borderWidth: selected ? 2 : layout.borderControl,
                backgroundColor: selected || pressed ? colors.surface : "transparent",
              },
            ]}
          >
            <Text variant="label" tone={selected ? "primary" : "secondary"} style={selected ? styles.chipSelected : undefined}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export type JournalView = "list" | "calendar" | "progress";

const journalViews = [
  { value: "list", label: "Liste" },
  { value: "calendar", label: "Calendrier" },
  { value: "progress", label: "Progression" },
] as const;

function journalPath(view: JournalView): "/journal" | "/journal/calendar" | "/journal/progress" {
  switch (view) {
    case "list":
      return "/journal";
    case "calendar":
      return "/journal/calendar";
    case "progress":
      return "/journal/progress";
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }
}

interface JournalHeaderProps {
  readonly view: JournalView;
  readonly trailing?: ReactNode;
}

export function JournalHeader({ view, trailing }: JournalHeaderProps) {
  return (
    <>
      <AppBar title="Journal" trailing={trailing} />
      <ViewSwitch<JournalView> items={journalViews} value={view} onChange={(next) => (next === view ? undefined : router.replace(journalPath(next)))} />
    </>
  );
}

const styles = StyleSheet.create({
  detail: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 6, rowGap: 2 },
  pain: { flexDirection: "row", alignItems: "center", gap: 6 },
  chipsScroll: { marginHorizontal: -layout.gutter, flexGrow: 0 },
  chips: { paddingHorizontal: layout.gutter, gap: 6 },
  chip: { minHeight: 48, paddingHorizontal: 16, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
  chipSelected: { fontFamily: fonts.text700 },
});
