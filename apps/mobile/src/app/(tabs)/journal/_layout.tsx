import { Stack } from "expo-router";
import { useTheme } from "@/ui/theme";

export default function JournalLayout() {
  const { colors } = useTheme();
  return <Stack screenOptions={{ headerShown: false, animation: "none", contentStyle: { backgroundColor: colors.bg } }} />;
}
