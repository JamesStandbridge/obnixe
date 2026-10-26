import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { programLimits } from "@obnixe/core";
import type { DraftItem, ItemTarget } from "@obnixe/core";
import type { Exercise, ExerciseMeasure, Id, ZoneKey } from "@obnixe/schema";
import { equipmentLabels, formatClock, measureLabels, zoneLabel } from "@/features/programs/format";
import { ControlButton, SheetButton } from "@/ui/Button";
import { Stepper } from "@/ui/Controls";
import { Question, Scale } from "@/ui/Inputs";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii } from "@/ui/tokens";

export function defaultTarget(measure: ExerciseMeasure): ItemTarget {
  return measure === "duration" ? { kind: "duration", minSeconds: 30, maxSeconds: 45 } : { kind: "reps", min: 8, max: 12 };
}

export function defaultRest(measure: ExerciseMeasure): number {
  switch (measure) {
    case "load_reps":
      return 120;
    case "bodyweight_reps":
      return 90;
    case "duration":
      return 60;
    default: {
      const unreachable: never = measure;
      return unreachable;
    }
  }
}

export function newItem(exercise: Exercise, lineageId: Id): DraftItem {
  return { lineageId, exerciseId: exercise.id, sets: 3, target: defaultTarget(exercise.measure), targetRir: exercise.measure === "duration" ? null : 2, restSeconds: defaultRest(exercise.measure), restAfterSeconds: null };
}

export function withExercise(item: DraftItem, exercise: Exercise): DraftItem {
  const fits = (exercise.measure === "duration") === (item.target.kind === "duration");
  return { ...item, exerciseId: exercise.id, target: fits ? item.target : defaultTarget(exercise.measure), targetRir: fits ? item.targetRir : exercise.measure === "duration" ? null : 2 };
}

interface ItemSheetProps {
  readonly item: DraftItem;
  readonly exercise: Exercise | null;
  readonly zones: readonly ZoneKey[];
  readonly isNew: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onChangeExercise: (item: DraftItem) => void;
  readonly onSave: (item: DraftItem) => void;
  readonly onMove: (offset: number) => void;
  readonly onRemove: () => void;
}

const rirOptions = [0, 1, 2, 3, 4, 5].map((value) => ({ value, label: String(value) }));

export function ItemSheet({ item: initial, exercise, zones, isNew, canMoveUp, canMoveDown, onChangeExercise, onSave, onMove, onRemove }: ItemSheetProps) {
  const { colors } = useTheme();
  const [item, setItem] = useState(initial);
  const target = item.target;
  const unavailable = exercise === null || exercise.archivedAt !== null || exercise.mergedIntoId !== null;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Exercice ${exercise?.name ?? "introuvable"}, changer`}
        onPress={() => onChangeExercise(item)}
        style={({ pressed }) => [styles.exercise, { backgroundColor: pressed ? colors.surfacePress : colors.surface2 }]}
      >
        <View style={styles.exerciseMain}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {exercise === null ? "Exercice introuvable" : unavailable ? "Archivé, à remplacer" : `${equipmentLabels[exercise.equipment]} · ${measureLabels[exercise.measure]}`}
          </Text>
          <Text variant="small" tone="secondary" numberOfLines={2}>
            {zones.length === 0 ? "Aucune zone sollicitée" : zones.map(zoneLabel).join(", ")}
          </Text>
        </View>
        <Text variant="label" style={styles.change}>
          Changer
        </Text>
      </Pressable>
      <Question title="Séries">
        <Stepper
          label="Séries"
          value={item.sets}
          step={1}
          min={programLimits.sets.min}
          max={programLimits.sets.max}
          unit=""
          format={String}
          onChange={(sets) => setItem({ ...item, sets })}
        />
      </Question>
      {target.kind === "reps" ? (
        <Question title="Répétitions" hint="fourchette visée">
          <RangeSteppers
            label="Répétitions"
            min={target.min}
            max={target.max}
            step={1}
            limits={programLimits.reps}
            unit={() => ""}
            format={String}
            onChange={(min, max) => setItem({ ...item, target: { kind: "reps", min, max } })}
          />
        </Question>
      ) : (
        <Question title="Durée par série" hint="fourchette visée">
          <RangeSteppers
            label="Durée"
            min={target.minSeconds}
            max={target.maxSeconds}
            step={5}
            limits={{ min: 5, max: programLimits.durationSeconds.max }}
            unit={(value) => (value >= 60 ? "" : "s")}
            format={(value) => (value >= 60 ? formatClock(value) : String(value))}
            onChange={(minSeconds, maxSeconds) => setItem({ ...item, target: { kind: "duration", minSeconds, maxSeconds } })}
          />
        </Question>
      )}
      <Question title="RIR visé" hint="reps en réserve, facultatif">
        <Scale<number> label="RIR visé" optional options={rirOptions} value={item.targetRir} onChange={(targetRir) => setItem({ ...item, targetRir })} />
      </Question>
      <Question title="Repos entre séries">
        <Stepper
          label="Repos"
          value={item.restSeconds ?? 0}
          step={15}
          min={0}
          max={600}
          unit={item.restSeconds === null ? "" : "min"}
          format={(value) => (value === 0 ? "—" : formatClock(value))}
          onChange={(value) => setItem({ ...item, restSeconds: value === 0 ? null : value })}
        />
      </Question>
      <SheetButton label={isNew ? "Ajouter à la séance" : "Valider"} disabled={unavailable} onPress={() => onSave(item)} style={styles.save} />
      {isNew ? null : (
        <View style={styles.actions}>
          <ControlButton label="Monter" disabled={!canMoveUp} onPress={() => onMove(-1)} style={styles.action} />
          <ControlButton label="Descendre" disabled={!canMoveDown} onPress={() => onMove(1)} style={styles.action} />
          <ControlButton label="Retirer" onPress={onRemove} style={styles.action} />
        </View>
      )}
    </View>
  );
}

interface RangeSteppersProps {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly limits: { readonly min: number; readonly max: number };
  readonly unit: (value: number) => string;
  readonly format: (value: number) => string;
  readonly onChange: (min: number, max: number) => void;
}

function RangeSteppers({ label, min, max, step, limits, unit, format, onChange }: RangeSteppersProps) {
  return (
    <View style={styles.range}>
      <View style={styles.rangeSide}>
        <Text variant="caption" tone="secondary">
          Min
        </Text>
        <Stepper label={`${label} minimum`} value={min} step={step} min={limits.min} max={limits.max} unit={unit(min)} format={format} onChange={(next) => onChange(next, Math.max(next, max))} />
      </View>
      <View style={styles.rangeSide}>
        <Text variant="caption" tone="secondary">
          Max
        </Text>
        <Stepper label={`${label} maximum`} value={max} step={step} min={limits.min} max={limits.max} unit={unit(max)} format={format} onChange={(next) => onChange(Math.min(min, next), next)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  exercise: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, paddingHorizontal: 14, paddingVertical: 10, borderRadius: radii.panel, marginTop: 4 },
  exerciseMain: { flex: 1, minWidth: 0, gap: 3 },
  change: { fontFamily: fonts.text700, textDecorationLine: "underline" },
  range: { flexDirection: "row", gap: 10 },
  rangeSide: { flex: 1, gap: 6 },
  save: { marginTop: 20 },
  actions: { flexDirection: "row", gap: 6, marginTop: 10 },
  action: { flex: 1 },
});
