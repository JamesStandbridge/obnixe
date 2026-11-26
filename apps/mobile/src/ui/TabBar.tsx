import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { BottomTabBarProps } from "expo-router/tabs";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Polygon } from "react-native-svg";
import { selectionAsync } from "expo-haptics";
import { Icon } from "@/ui/icons/Icon";
import type { IconName } from "@/ui/icons/Icon";
import { useSpringTo } from "@/ui/motion";
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

const barPadding = 8;
const pillWidth = 58;
const pillHeight = 32;
const pillSkew = 9;

export function TabBar({ state, navigateToTab }: BottomTabBarProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [width, setWidth] = useState(0);
  const shown = state.routes.filter((route) => tabs.some((tab) => tab.route === route.name));
  const activeKey = state.routes[state.index]?.key;
  const active = Math.max(0, shown.findIndex((route) => route.key === activeKey));
  const position = useSpringTo(active, active);
  const tabWidth = shown.length === 0 ? 0 : (width - barPadding * 2) / shown.length;
  const pillStyle = useAnimatedStyle(() => ({ transform: [{ translateX: barPadding + position.value * tabWidth + (tabWidth - pillWidth) / 2 }] }));

  return (
    <View
      accessibilityRole="tablist"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.bar, { backgroundColor: colors.bg, borderTopColor: colors.line, paddingBottom: insets.bottom, height: layout.tabbarHeight + insets.bottom }]}
    >
      {width === 0 ? null : (
        <Animated.View pointerEvents="none" style={[styles.pill, pillStyle]}>
          <Svg width={pillWidth} height={pillHeight}>
            <Polygon points={`${pillSkew},0 ${pillWidth},0 ${pillWidth - pillSkew},${pillHeight} 0,${pillHeight}`} fill={colors.brand} />
          </Svg>
        </Animated.View>
      )}
      {shown.map((route) => {
        const tab = tabs.find((candidate) => candidate.route === route.name);
        if (tab === undefined) return null;
        const focused = route.key === activeKey;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            aria-selected={focused}
            accessibilityLabel={tab.label}
            onPress={() => {
              if (!focused) void selectionAsync();
              navigateToTab(route.key);
            }}
            style={styles.tab}
          >
            <View style={styles.iconSlot}>
              <Icon name={tab.icon} color={focused ? colors.brandInk : colors.text2} />
            </View>
            <Text variant="caption" tone={focused ? "primary" : "secondary"} style={[styles.label, focused && styles.labelFocused]} maxFontSizeMultiplier={1.2}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", paddingHorizontal: barPadding, borderTopWidth: 1 },
  pill: { position: "absolute", top: 8, left: 0 },
  tab: { flex: 1, alignItems: "center", paddingTop: 8, gap: 4 },
  iconSlot: { height: pillHeight, alignItems: "center", justifyContent: "center" },
  label: { fontFamily: fonts.text600, fontSize: 12, letterSpacing: 0.24 },
  labelFocused: { fontFamily: fonts.text700 },
});
