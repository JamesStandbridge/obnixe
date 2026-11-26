import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { recentSpeedOf, resolveProfile } from "@obnixe/core";
import type { DraftSlot, DraftVariant } from "@obnixe/core";
import { db } from "@/data/database";
import type { DraftAction } from "@/features/programs/editor/draftReducer";
import { WorkoutEditor } from "@/features/workouts/WorkoutEditor";
import { defaultWorkout } from "@/features/workouts/plan";
import { ControlButton, SheetButton } from "@/ui/Button";
import { Question, TextField } from "@/ui/Inputs";
import { Text } from "@/ui/Text";

interface WorkoutSheetProps {
  readonly slot: DraftSlot;
  readonly variant: DraftVariant;
  readonly dispatch: (action: DraftAction) => void;
  readonly onRemove: () => void;
  readonly onDone: () => void;
}

/** A guided variant of an endurance slot (`DEC-10`): its name and its course (`WKT-001`). */
export function WorkoutSheet({ slot, variant, dispatch, onRemove, onDone }: WorkoutSheetProps) {
  const profile = resolveProfile(slot.sport, slot.targetValues);
  const referenceSpeedMmS = useMemo(() => recentSpeedOf(db(), slot.sport), [slot.sport]);
  return (
    <View>
      <Question title="Nom">
        <TextField
          value={variant.name}
          onChangeText={(name) => dispatch({ type: "rename_variant", slotId: slot.lineageId, variantId: variant.lineageId, name })}
          placeholder="Nom de la séance guidée"
          accessibilityLabel="Nom de la séance guidée"
        />
      </Question>
      {profile === null ? (
        <Text variant="small" tone="secondary" style={styles.notice}>
          Ce sport n'enregistre pas de trace avec ces réglages : la séance ne peut pas être guidée.
        </Text>
      ) : (
        <Question title="Déroulé">
          <WorkoutEditor
            plan={variant.workout ?? defaultWorkout(profile.primary)}
            measure={profile.primary}
            referenceSpeedMmS={referenceSpeedMmS}
            onChange={(workout) => dispatch({ type: "set_workout", slotId: slot.lineageId, variantId: variant.lineageId, workout })}
          />
        </Question>
      )}
      <SheetButton label="Terminé" onPress={onDone} style={styles.done} />
      <ControlButton label="Supprimer la séance guidée" onPress={onRemove} style={styles.remove} />
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { marginTop: 12 },
  done: { marginTop: 20 },
  remove: { marginTop: 10 },
});
