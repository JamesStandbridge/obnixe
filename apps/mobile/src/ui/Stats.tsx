import { StyleSheet, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";

export interface StatValue {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
}

interface StatRowProps {
  readonly stats: readonly StatValue[];
  readonly size?: "regular" | "large";
  readonly style?: StyleProp<ViewStyle>;
}

export function StatRow({ stats, size = "regular", style }: StatRowProps) {
  const { colors } = useTheme();
  const large = size === "large";
  return (
    <View style={[styles.row, style]}>
      {stats.map((stat, index) => (
        <View
          key={stat.label}
          accessible
          accessibilityLabel={`${stat.label} ${stat.value} ${stat.unit}`.trim()}
          style={[styles.stat, index > 0 && { borderLeftWidth: 1, borderLeftColor: colors.line, paddingLeft: 12 }]}
        >
          <Text variant="caption" tone="secondary" numberOfLines={1}>
            {stat.label}
          </Text>
          <Text style={large ? styles.valueLarge : styles.value} numberOfLines={1}>
            {stat.value}
            {stat.unit === "" ? null : (
              <Text tone="secondary" style={large ? styles.unitLarge : styles.unit}>
                {` ${stat.unit}`}
              </Text>
            )}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 12 },
  stat: { flex: 1, minWidth: 0, gap: 2 },
  value: { fontFamily: fonts.figure700, fontSize: 22, lineHeight: 25 },
  unit: { fontFamily: fonts.figure600, fontSize: 14 },
  valueLarge: { fontFamily: fonts.figure800, fontSize: 30, lineHeight: 33, letterSpacing: -0.3 },
  unitLarge: { fontFamily: fonts.figure600, fontSize: 16 },
});
