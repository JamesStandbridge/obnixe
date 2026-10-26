import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { hideAsync } from "expo-splash-screen";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { layout } from "@/ui/tokens";

interface StartupErrorProps {
  readonly title: string;
  readonly detail: string;
}

export function StartupError({ title, detail }: StartupErrorProps) {
  const { colors } = useTheme();
  useEffect(() => {
    void hideAsync();
  }, []);
  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Text variant="sheetTitle">{title}</Text>
      <Text variant="small" tone="secondary" selectable>
        {detail}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "center", gap: 8, paddingHorizontal: layout.gutter },
});
