import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { CodedError } from "expo";
import { remindersCalendar, toggleWeekday, weekdayIndexes, weekdaysOf } from "@obnixe/core";
import { settings } from "@obnixe/schema";
import type { MassUnit, Settings } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { shareFile } from "@/features/data/files";
import { clock, localDateOf, weekdayInitials, weekdayLabels } from "@/features/data/format";
import { SheetButton } from "@/ui/Button";
import { Stepper } from "@/ui/Controls";
import { Choices, Question } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";

export const massUnitLabels: Readonly<Record<MassUnit, string>> = { kg: "kg", lb: "lb" };

export function updateSettings(patch: Partial<Omit<Settings, "singleton" | "updatedAt">>): void {
  db()
    .update(settings)
    .set({ ...patch, updatedAt: environment.now() })
    .run();
}

interface MassUnitSheetProps {
  readonly open: boolean;
  readonly value: MassUnit;
  readonly onClose: () => void;
}

export function MassUnitSheet({ open, value, onClose }: MassUnitSheetProps) {
  return (
    <Sheet open={open} title="Charges et poids" context="Les valeurs enregistrées ne changent pas, seul l'affichage suit" onClose={onClose}>
      <Choices
        items={[
          { value: "kg", label: "Kilogrammes (kg)", primary: value === "kg" },
          { value: "lb", label: "Livres (lb)", primary: value === "lb" },
        ]}
        onChoose={(massUnit: MassUnit) => {
          updateSettings({ massUnit });
          onClose();
        }}
      />
    </Sheet>
  );
}

interface RemindersSheetProps {
  readonly open: boolean;
  readonly weekdays: number;
  readonly minutes: number;
  readonly onClose: () => void;
}

export function RemindersSheet({ open, weekdays, minutes, onClose }: RemindersSheetProps) {
  const { colors } = useTheme();
  const [mask, setMask] = useState(weekdays);
  const [time, setTime] = useState(minutes);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMask(weekdays);
    setTime(minutes);
    setFailure(null);
  }, [open, weekdays, minutes]);

  const exportCalendar = async (): Promise<void> => {
    const now = environment.now();
    const calendar = remindersCalendar({ weekdays: mask, minutes: time, from: localDateOf(now), now, uid: environment.newId(), title: "Séance Obnixe" });
    try {
      await shareFile({ name: "obnixe-rappels.ics", bytes: calendar, mimeType: "text/calendar" });
    } catch (error) {
      if (!(error instanceof CodedError)) throw error;
      setFailure("Impossible d'ouvrir l'agenda");
      return;
    }
    updateSettings({ reminderWeekdays: mask, reminderMinutes: time, remindersExportedAt: now });
    onClose();
  };

  const selected = weekdaysOf(mask);

  return (
    <Sheet open={open} title="Rappels dans l'agenda" context="Un événement répété dans ton agenda, sans notification de l'app" onClose={onClose}>
      <Question title="Jours" {...(selected.length === 0 ? { hint: "au moins un" } : {})}>
        <View style={styles.days} accessibilityRole="none">
          {weekdayIndexes.map((day) => {
            const pressed = selected.includes(day);
            return (
              <Pressable
                key={day}
                accessibilityRole="checkbox"
                accessibilityLabel={weekdayLabels[day]}
                aria-checked={pressed}
                onPress={() => setMask((current) => toggleWeekday(current, day))}
                style={({ pressed: touching }) => [
                  styles.day,
                  {
                    borderColor: pressed ? colors.text : colors.controlBorder,
                    borderWidth: pressed ? 2 : layout.borderControl,
                    backgroundColor: pressed || touching ? colors.surface : "transparent",
                  },
                ]}
              >
                <Text variant="label" tone={pressed ? "primary" : "secondary"} style={pressed ? styles.dayOn : null}>
                  {weekdayInitials[day]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Question>
      <Question title="Heure">
        <Stepper value={time} step={15} min={0} max={23 * 60 + 45} unit="" label="Heure" format={clock} onChange={setTime} />
      </Question>
      {failure === null ? null : (
        <Text variant="small" tone="secondary" style={styles.failure} accessibilityLiveRegion="polite">
          {failure}
        </Text>
      )}
      <SheetButton label="Ajouter à l'agenda" disabled={selected.length === 0} onPress={() => void exportCalendar()} style={styles.action} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  days: { flexDirection: "row", gap: 6 },
  day: { flex: 1, minHeight: 48, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
  dayOn: { fontFamily: fonts.text700 },
  failure: { marginTop: 12 },
  action: { marginTop: 16 },
});
