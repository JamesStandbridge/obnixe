import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Switch } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import { IconButton } from "@/ui/Inputs";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout } from "@/ui/tokens";

interface SwitchRowProps {
  readonly title: string;
  readonly detail?: string;
  readonly leading?: ReactNode;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly disabled?: boolean;
  readonly divided?: boolean;
  readonly large?: boolean;
}

export function SwitchRow({ title, detail, leading, value, onChange, disabled = false, divided = false, large = false }: SwitchRowProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={detail === undefined ? title : `${title}, ${detail}`}
      aria-checked={value}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={({ pressed }) => [
        styles.switchRow,
        large ? styles.switchRowLarge : null,
        divided ? { borderTopWidth: 1, borderTopColor: colors.line } : null,
        pressed ? { opacity: 0.7 } : null,
      ]}
    >
      {leading}
      <View style={styles.switchText}>
        <Text style={large ? styles.largeTitle : styles.title}>{title}</Text>
        {detail === undefined ? null : (
          <Text variant="caption" tone="secondary" style={styles.detail}>
            {detail}
          </Text>
        )}
      </View>
      <View pointerEvents="none" aria-hidden style={disabled ? styles.disabled : null}>
        <Switch value={value} onChange={onChange} label={title} />
      </View>
    </Pressable>
  );
}

export function NoticeMark() {
  const { colors } = useTheme();
  return <View aria-hidden style={[styles.notice, { borderColor: colors.warn }]} />;
}

export function Chevron() {
  const { colors } = useTheme();
  return <Icon name="chevron" color={colors.text3} />;
}

export function BackButton() {
  return <IconButton icon="back" label="Retour" edge="start" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} />;
}

interface BottomPanelProps {
  readonly children: ReactNode;
}

export function BottomPanel({ children }: BottomPanelProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bottom, { backgroundColor: colors.bg, borderTopColor: colors.line, paddingBottom: insets.bottom + 12 }]}>{children}</View>
  );
}

const styles = StyleSheet.create({
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56 },
  switchRowLarge: { minHeight: 60 },
  switchText: { flex: 1, gap: 2 },
  title: { fontFamily: fonts.text600, fontSize: 16, lineHeight: 21 },
  largeTitle: { fontFamily: fonts.text600, fontSize: 17, lineHeight: 22 },
  detail: { fontFamily: fonts.text500 },
  disabled: { opacity: 0.4 },
  notice: { width: 8, height: 8, borderWidth: 2, transform: [{ rotate: "45deg" }] },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopWidth: 1, paddingTop: 10, paddingHorizontal: layout.gutter, gap: 10 },
});
