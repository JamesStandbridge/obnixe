import { Pressable, StyleSheet, View } from "react-native";
import type { BottomTabBarProps } from "expo-router/tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/ui/icons/Icon";
import type { IconName } from "@/ui/icons/Icon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout } from "@/ui/tokens";

export interface TabDefinition {
  readonly route: string;
  readonly label: string;
  readonly icon: IconName;
}

export const tabs: readonly TabDefinition[] = [
  { route: "index", label: "Aujourd'hui", icon: "tabToday" },
  { route: "journal", label: "Journal", icon: "tabJournal" },
  { route: "body", label: "Corps", icon: "tabBody" },
  { route: "programs", label: "Programmes", icon: "tabPrograms" },
];

export function TabBar({ state, navigateToTab }: BottomTabBarProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="tablist"
      style={[styles.bar, { backgroundColor: colors.bg, borderTopColor: colors.line, paddingBottom: insets.bottom, height: layout.tabbarHeight + insets.bottom }]}
    >
      {state.routes.map((route, index) => {
        const tab = tabs.find((candidate) => candidate.route === route.name);
        if (tab === undefined) return null;
        const focused = state.index === index;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            aria-selected={focused}
            accessibilityLabel={tab.label}
            onPress={() => navigateToTab(route.key)}
            style={styles.tab}
          >
            {focused ? <View style={[styles.indicator, { backgroundColor: colors.mark }]} /> : null}
            <Icon name={tab.icon} color={focused ? colors.text : colors.text2} />
            <Text variant="caption" tone={focused ? "primary" : "secondary"} style={styles.label} maxFontSizeMultiplier={1.2}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", paddingHorizontal: 8, borderTopWidth: 1 },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", gap: 4 },
  indicator: { position: "absolute", top: -1, left: "22%", right: "22%", height: 3, borderBottomLeftRadius: 2, borderBottomRightRadius: 2 },
  label: { fontFamily: fonts.text600, fontSize: 12, letterSpacing: 0.24 },
});
