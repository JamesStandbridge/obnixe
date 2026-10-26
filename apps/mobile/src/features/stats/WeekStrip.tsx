import { StyleSheet, View } from "react-native";
import { dateParts, weekdayIndex } from "@obnixe/core";
import type { WeekDay, WeekDayState } from "@obnixe/core";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";
import { longDate, weekdayLetters } from "@/features/stats/format";

function stateWords(state: WeekDayState): string {
  switch (state) {
    case "done":
      return "séance faite";
    case "planned":
      return "séance prévue";
    case "rest":
      return "repos";
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

interface WeekStripProps {
  readonly days: readonly WeekDay[];
}

export function WeekStrip({ days }: WeekStripProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.week}>
      {days.map((day) => {
        const bar =
          day.isToday
            ? { height: 6, borderRadius: 3, backgroundColor: colors.mark }
            : day.state === "done"
              ? { backgroundColor: colors.stepDone }
              : day.state === "planned"
                ? { backgroundColor: "transparent", borderWidth: layout.borderControl, borderColor: colors.controlBorder }
                : { backgroundColor: colors.surface2 };
        return (
          <View
            key={day.date}
            accessible
            accessibilityLabel={`${longDate(day.date)}, ${stateWords(day.state)}${day.isToday ? ", aujourd'hui" : ""}`}
            style={[styles.day, day.isToday && { backgroundColor: colors.surface }]}
          >
            <Text tone="secondary" style={styles.letter}>
              {weekdayLetters[weekdayIndex(day.date)]}
            </Text>
            <Text style={styles.date}>{dateParts(day.date).day}</Text>
            <View style={[styles.bar, bar]} />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  week: { flexDirection: "row", gap: 4, marginTop: 10 },
  day: { flex: 1, alignItems: "center", gap: 6, paddingTop: 8, paddingBottom: 10, borderRadius: radii.control },
  letter: { fontFamily: fonts.text700, fontSize: 12, lineHeight: 12, letterSpacing: 0.48 },
  date: { fontFamily: fonts.figure700, fontSize: 17, lineHeight: 17 },
  bar: { width: "100%", maxWidth: 30, height: 4, borderRadius: 2 },
});
