import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { activeSeconds, localDateOf } from "@obnixe/core";
import type { EpochMs, LocalDate, Session } from "@obnixe/schema";
import { formatLongDate, formatTime } from "@/features/training/format";
import { SheetButton } from "@/ui/Button";
import { Stepper } from "@/ui/Controls";
import { Question } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";

export interface SessionTiming {
  readonly startedAt: EpochMs;
  readonly endedAt: EpochMs;
  readonly localDate: LocalDate;
}

interface DateSheetProps {
  readonly open: boolean;
  readonly session: Session;
  readonly onClose: () => void;
  readonly onSave: (timing: SessionTiming) => void;
}

const dayMs = 86_400_000;
const minuteMs = 60_000;

export function DateSheet({ open, session, onClose, onSave }: DateSheetProps) {
  const initialMinutes = Math.max(1, Math.round(activeSeconds(session, session.startedAt) / 60));
  const [days, setDays] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [duration, setDuration] = useState(initialMinutes);
  useEffect(() => {
    if (!open) return;
    setDays(0);
    setMinutes(0);
    setDuration(initialMinutes);
  }, [open, initialMinutes]);

  const startedAt = (session.startedAt + days * dayMs + minutes * minuteMs) as EpochMs;
  const save = (): void => {
    onSave({ startedAt, endedAt: (startedAt + (duration * 60 + session.pausedSeconds) * 1000) as EpochMs, localDate: localDateOf(startedAt, session.timeZone) });
  };

  return (
    <Sheet open={open} title="Changer la date ou l'heure" onClose={onClose}>
      <Question title="Jour">
        <Shift text={formatLongDate(localDateOf(startedAt, session.timeZone))} earlier="Jour précédent" later="Jour suivant" canLater={days < 0} onShift={(direction) => setDays(days + direction)} />
      </Question>
      <Question title="Début">
        <Shift text={formatTime(startedAt, session.timeZone)} earlier="5 minutes plus tôt" later="5 minutes plus tard" canLater onShift={(direction) => setMinutes(minutes + direction * 5)} />
      </Question>
      <Question title="Durée">
        <Stepper value={duration} step={1} min={1} max={24 * 60} unit="min" label="Durée" format={(value) => String(value)} onChange={setDuration} />
      </Question>
      <SheetButton label="Enregistrer" onPress={save} style={styles.save} />
    </Sheet>
  );
}

interface ShiftProps {
  readonly text: string;
  readonly earlier: string;
  readonly later: string;
  readonly canLater: boolean;
  readonly onShift: (direction: 1 | -1) => void;
}

function Shift({ text, earlier, later, canLater, onShift }: ShiftProps) {
  const { colors } = useTheme();
  const button = (label: string, glyph: string, direction: 1 | -1, enabled: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={() => onShift(direction)}
      style={({ pressed }) => [styles.step, { backgroundColor: pressed ? colors.surfacePress : colors.surface, borderColor: colors.controlBorder }, !enabled && styles.disabled]}
    >
      <Text style={styles.stepLabel}>{glyph}</Text>
    </Pressable>
  );
  return (
    <View style={styles.shift}>
      {button(earlier, "−", -1, true)}
      <Text style={styles.value} accessibilityLiveRegion="polite" numberOfLines={1}>
        {text}
      </Text>
      {button(later, "+", 1, canLater)}
    </View>
  );
}

const styles = StyleSheet.create({
  shift: { flexDirection: "row", alignItems: "center", gap: 6 },
  step: { width: 56, height: 56, borderRadius: radii.control, borderWidth: layout.borderControl, alignItems: "center", justifyContent: "center" },
  stepLabel: { fontFamily: fonts.figure700, fontSize: 22, lineHeight: 24 },
  value: { flex: 1, textAlign: "center", fontFamily: fonts.text700, fontSize: 18 },
  disabled: { opacity: 0.4 },
  save: { marginTop: 20 },
});
