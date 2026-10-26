import { StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { sports } from "@obnixe/schema";
import { colors } from "@/theme";

export default function Today() {
  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>Obnixe</Text>
      <Text style={styles.meta}>{Object.values(sports).map((sport) => sport.label).join(" · ")}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 18, paddingTop: 18, gap: 6, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 30, fontWeight: "700", letterSpacing: -0.6 },
  meta: { color: colors.text2, fontSize: 15 },
});
