import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { reveal } from "@/ui/motion";
import { Slash } from "@/ui/Shapes";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { layout } from "@/ui/tokens";

interface ScreenProps {
  readonly children: ReactNode;
  readonly bottomInset?: number;
}

export function Screen({ children, bottomInset = 32 }: ScreenProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{
        paddingTop: insets.top + 14,
        paddingHorizontal: layout.gutter,
        paddingBottom: insets.bottom + bottomInset,
      }}
    >
      {children}
    </ScrollView>
  );
}

interface AppBarProps {
  readonly title: string;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly variant?: "title" | "context";
}

export function AppBar({ title, leading, trailing, variant = "title" }: AppBarProps) {
  return (
    <View style={styles.appbar}>
      {leading}
      <Text
        variant={variant === "title" ? "title" : "label"}
        tone={variant === "title" ? "primary" : "secondary"}
        accessibilityRole="header"
        style={styles.appbarTitle}
      >
        {title}
      </Text>
      {trailing}
    </View>
  );
}

interface SectionProps {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}

export function Section({ title, action, children, style }: SectionProps) {
  const { colors } = useTheme();
  return (
    <Animated.View entering={reveal(1)} style={[styles.section, style]}>
      <View style={styles.sectionHead}>
        <View style={styles.sectionTitle}>
          <Slash color={colors.mark} width={10} height={14} />
          <Text variant="heading" accessibilityRole="header" style={styles.sectionTitleText}>
            {title}
          </Text>
        </View>
        {action}
      </View>
      {children}
    </Animated.View>
  );
}

interface RowProps {
  readonly title: string;
  readonly detail?: ReactNode;
  readonly leading?: ReactNode;
  readonly value?: string;
  readonly valueDetail?: string;
  readonly trailing?: ReactNode;
  readonly onPress?: () => void;
  readonly last?: boolean;
}

export function Row({ title, detail, leading, value, valueDetail, trailing, onPress, last = false }: RowProps) {
  const { colors } = useTheme();
  const content = (
    <>
      {leading}
      <View style={styles.rowMain}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {title}
        </Text>
        {detail === undefined ? null : typeof detail === "string" ? (
          <Text variant="small" tone="secondary">
            {detail}
          </Text>
        ) : (
          detail
        )}
      </View>
      {value === undefined ? null : (
        <View style={styles.rowValue}>
          <Text variant="value">{value}</Text>
          {valueDetail === undefined ? null : (
            <Text variant="caption" tone="secondary">
              {valueDetail}
            </Text>
          )}
        </View>
      )}
      {trailing}
    </>
  );
  const border = { borderBottomColor: colors.line, borderBottomWidth: last ? 0 : 1 };
  if (onPress === undefined) return <View style={[styles.row, border]}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, border, pressed && { backgroundColor: colors.surface }]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  appbar: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  appbarTitle: { flex: 1 },
  section: { marginTop: 32 },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minHeight: 32,
    paddingBottom: 4,
  },
  sectionTitle: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  sectionTitleText: { flexShrink: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 10 },
  rowMain: { flex: 1, minWidth: 0, gap: 3 },
  rowValue: { alignItems: "flex-end", gap: 4 },
});
