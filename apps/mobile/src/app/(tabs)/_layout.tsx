import { Tabs } from "expo-router";
import { TabBar } from "@/ui/TabBar";
import { useTheme } from "@/ui/theme";

export default function TabsLayout() {
  const { colors } = useTheme();
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="journal" />
      <Tabs.Screen name="body" />
      <Tabs.Screen name="programs" />
    </Tabs>
  );
}
