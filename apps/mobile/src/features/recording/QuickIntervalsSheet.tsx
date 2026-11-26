import { useState } from "react";
import { StyleSheet, View } from "react-native";
import type { WorkoutPlan } from "@obnixe/schema";
import { WorkoutEditor } from "@/features/workouts/WorkoutEditor";
import { workoutIssue } from "@/features/workouts/plan";
import type { Measure } from "@/features/workouts/plan";
import { ControlButton, SheetButton } from "@/ui/Button";
import { Sheet } from "@/ui/Overlays";

interface QuickIntervalsSheetProps {
  readonly open: boolean;
  /** Changes at each opening, to start again from `initial`. */
  readonly opening: number;
  readonly initial: WorkoutPlan;
  readonly measure: Measure;
  readonly referenceSpeedMmS: number | null;
  /** Whether a quick workout is already chosen, to offer removing it. */
  readonly chosen: boolean;
  readonly onUse: (plan: WorkoutPlan) => void;
  readonly onClear: () => void;
  readonly onClose: () => void;
}

/** `WKT-008`: a one-off guided workout outside the program, filled in from the last one used. */
export function QuickIntervalsSheet({ open, opening, initial, measure, referenceSpeedMmS, chosen, onUse, onClear, onClose }: QuickIntervalsSheetProps) {
  return (
    <Sheet open={open} title="Fractionné rapide" context="Pour cette sortie, hors programme" onClose={onClose}>
      <QuickIntervalsForm key={opening} initial={initial} measure={measure} referenceSpeedMmS={referenceSpeedMmS} chosen={chosen} onUse={onUse} onClear={onClear} />
    </Sheet>
  );
}

type QuickIntervalsFormProps = Omit<QuickIntervalsSheetProps, "open" | "opening" | "onClose">;

function QuickIntervalsForm({ initial, measure, referenceSpeedMmS, chosen, onUse, onClear }: QuickIntervalsFormProps) {
  const [plan, setPlan] = useState<WorkoutPlan>(initial);
  return (
    <View>
      <WorkoutEditor plan={plan} measure={measure} referenceSpeedMmS={referenceSpeedMmS} onChange={setPlan} />
      <SheetButton label="Utiliser ce déroulé" disabled={workoutIssue(plan, measure) !== null} onPress={() => onUse(plan)} style={styles.use} />
      {chosen ? <ControlButton label="Sortir sans déroulé" onPress={onClear} style={styles.clear} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  use: { marginTop: 20 },
  clear: { marginTop: 10 },
});
