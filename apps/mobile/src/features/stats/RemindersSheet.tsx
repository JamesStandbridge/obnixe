import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import { clampReminderMinutes, daysBetween, reminderDays, reminderMinutesRange, remindersIcs, toggleReminderDay } from "@obnixe/core";
import { settings } from "@obnixe/schema";
import type { EpochMs, LocalDate } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { SheetButton } from "@/ui/Button";
import { Sheet } from "@/ui/Overlays";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";
import { capitalize, formatClockMinutes, localDateOf, shortDate, weekdayAbbrev, weekdayLetters, weekdayLong } from "@/features/stats/format";

const fileName = "obnixe-rappels.ics";

export function remindersSummary(mask: number, minutes: number, exportedAt: EpochMs | null, today: LocalDate): string {
  const days = reminderDays(mask);
  if (days.length === 0 || exportedAt === null) return "aucun";
  const exportedOn = localDateOf(exportedAt);
  const age = daysBetween(exportedOn, today);
  const when = age === 0 ? "aujourd'hui" : age === 1 ? "hier" : `le ${shortDate(exportedOn)}`;
  return `${days.map((day) => weekdayAbbrev[day]).join(", ")} à ${formatClockMinutes(minutes)} · exporté ${when}`;
}

interface RemindersSheetProps {
  readonly open: boolean;
  readonly mask: number;
  readonly minutes: number;
  readonly today: LocalDate;
  readonly onClose: () => void;
}

export function RemindersSheet({ open, mask: savedMask, minutes: savedMinutes, today, onClose }: RemindersSheetProps) {
  const { colors } = useTheme();
  const notify = useSnackbar();
  const [mask, setMask] = useState(savedMask);
  const [minutes, setMinutes] = useState(savedMinutes);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMask(savedMask);
    setMinutes(savedMinutes);
  }, [open, savedMask, savedMinutes]);

  const days = reminderDays(mask);

  const exportReminders = async (): Promise<void> => {
    if (days.length === 0 || busy) return;
    setBusy(true);
    try {
      if (!(await isAvailableAsync())) {
        onClose();
        notify({ text: "Partage indisponible sur cet appareil", aboveTabBar: true });
        return;
      }
      const stamp = environment.now();
      const file = new File(Paths.cache, fileName);
      if (file.exists) file.delete();
      file.create();
      file.write(remindersIcs({ mask, minutes, from: today, stamp, summary: "Séance Obnixe", description: "Ouvre Obnixe pour la séance du jour.", durationMinutes: 30 }));
      await shareAsync(file.uri, { mimeType: "text/calendar", UTI: "com.apple.ical.ics", dialogTitle: "Rappels dans l'agenda" });
      db().update(settings).set({ reminderWeekdays: mask, reminderMinutes: minutes, remindersExportedAt: stamp, updatedAt: stamp }).run();
      onClose();
      notify({ text: `${fileName} enregistré · ouvre-le avec ton agenda`, aboveTabBar: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} title="Rappels dans l'agenda" context="Un fichier .ics pour ton agenda" onClose={onClose}>
      <View style={styles.days} accessibilityLabel="Jours des rappels">
        {weekdayLetters.map((letter, day) => {
          const selected = days.includes(day);
          return (
            <Pressable
              key={day}
              accessibilityRole="checkbox"
              accessibilityLabel={capitalize(weekdayLong[day] ?? "")}
              accessibilityState={{ checked: selected }}
              onPress={() => setMask(toggleReminderDay(mask, day))}
              style={({ pressed }) => [
                styles.day,
                {
                  borderColor: selected ? colors.text : colors.controlBorder,
                  borderWidth: selected ? 2 : layout.borderControl,
                  backgroundColor: selected || pressed ? colors.surface : "transparent",
                },
              ]}
            >
              <Text variant="label" tone={selected ? "primary" : "secondary"} style={selected ? styles.daySelected : undefined}>
                {letter}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.time}>
        <Text variant="bodyStrong" style={styles.timeLabel}>
          Heure du rappel
        </Text>
        <View style={styles.stepper}>
          <StepButton label="−" accessibilityLabel="30 minutes plus tôt" disabled={minutes <= reminderMinutesRange.min} onPress={() => setMinutes(clampReminderMinutes(minutes - reminderMinutesRange.step))} />
          <View style={styles.stepValue} accessible accessibilityLabel={`Rappel à ${formatClockMinutes(minutes)}`}>
            <Text style={styles.stepFigure}>{formatClockMinutes(minutes)}</Text>
          </View>
          <StepButton label="+" accessibilityLabel="30 minutes plus tard" disabled={minutes >= reminderMinutesRange.max} onPress={() => setMinutes(clampReminderMinutes(minutes + reminderMinutesRange.step))} />
        </View>
      </View>
      <SheetButton
        label={days.length === 0 ? "Choisis au moins un jour" : `Exporter ${days.length} rappel${days.length > 1 ? "s" : ""} par semaine`}
        disabled={days.length === 0 || busy}
        onPress={() => void exportReminders()}
        style={styles.export}
      />
    </Sheet>
  );
}

interface StepButtonProps {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}

function StepButton({ label, accessibilityLabel, disabled, onPress }: StepButtonProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.step, { backgroundColor: pressed ? colors.surfacePress : colors.surface, borderColor: colors.controlBorder }, disabled && styles.disabled]}
    >
      <Text style={styles.stepLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  days: { marginTop: 14, flexDirection: "row", gap: 6 },
  day: { flex: 1, minHeight: 48, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
  daySelected: { fontFamily: fonts.text700 },
  time: { marginTop: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  timeLabel: { flex: 1 },
  stepper: { width: 176, flexDirection: "row", alignItems: "center", gap: 6 },
  step: { width: 52, height: 52, borderRadius: radii.control, borderWidth: layout.borderControl, alignItems: "center", justifyContent: "center" },
  stepLabel: { fontFamily: fonts.figure700, fontSize: 22, lineHeight: 24 },
  stepValue: { flex: 1, height: 52, alignItems: "center", justifyContent: "center" },
  stepFigure: { fontFamily: fonts.figure800, fontSize: 28, lineHeight: 32, letterSpacing: -0.3 },
  export: { marginTop: 14 },
  disabled: { opacity: 0.4 },
});
