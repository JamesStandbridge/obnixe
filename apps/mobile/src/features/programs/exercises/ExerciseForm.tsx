import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { findExerciseByName, planArchiveExercise, planCreateExercise, planRestoreExercise, planUpdateExercise, usesLoad } from "@obnixe/core";
import type { ExerciseInput, ExerciseUsage } from "@obnixe/core";
import { equipments, exerciseMeasures, zoneKeys, zones as zoneCatalog } from "@obnixe/schema";
import type { Equipment, Exercise, ExerciseMeasure, Id, MassUnit, ZoneKey } from "@obnixe/schema";
import { environment } from "@/data/database";
import { write } from "@/data/write";
import { Chips } from "@/features/programs/Chips";
import { equipmentLabels, formatLoadStep, measureLabels } from "@/features/programs/format";
import { ControlButton, SheetButton } from "@/ui/Button";
import { Segmented } from "@/ui/Controls";
import { Panel, Question, Scale, TextField } from "@/ui/Inputs";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";

const poundGrams = 453.59237;

const loadSteps: Readonly<Record<MassUnit, readonly number[]>> = {
  kg: [500, 1000, 1250, 2000, 2500, 4000, 5000],
  lb: [1, 2.5, 5, 10].map((pounds) => Math.round(pounds * poundGrams)),
};

function defaultStep(equipment: Equipment, unit: MassUnit): number {
  const steps = loadSteps[unit];
  switch (equipment) {
    case "barbell":
    case "machine":
    case "cable":
      return unit === "kg" ? 2500 : (steps[2] ?? 2268);
    case "kettlebell":
      return unit === "kg" ? 4000 : (steps[3] ?? 4536);
    case "dumbbell":
    case "bodyweight":
    case "band":
    case "other":
      return unit === "kg" ? 1000 : (steps[1] ?? 1134);
    default: {
      const unreachable: never = equipment;
      return unreachable;
    }
  }
}

function defaultEquipment(measure: ExerciseMeasure): Equipment {
  return measure === "load_reps" ? "barbell" : "bodyweight";
}

interface ExerciseFormProps {
  readonly exercise: Exercise | null;
  readonly exerciseZones: readonly ZoneKey[];
  readonly usage: ExerciseUsage;
  readonly initialName: string;
  readonly exercises: readonly Exercise[];
  readonly massUnit: MassUnit;
  readonly onDone: (exerciseId: Id) => void;
  readonly onArchived: () => void;
}

export function ExerciseForm({ exercise, exerciseZones, usage, initialName, exercises, massUnit, onDone, onArchived }: ExerciseFormProps) {
  const { colors } = useTheme();
  const [input, setInput] = useState<ExerciseInput>(() =>
    exercise === null
      ? { name: initialName, measure: "load_reps", equipment: "barbell", loadStepGrams: defaultStep("barbell", massUnit), zones: [] }
      : { name: exercise.name, measure: exercise.measure, equipment: exercise.equipment, loadStepGrams: exercise.loadStepGrams, zones: exerciseZones },
  );
  const [stepTouched, setStepTouched] = useState(exercise !== null);
  const taken = findExerciseByName(exercises, input.name, exercise?.id ?? null);
  const measureLocked = exercise !== null && usage.inUse;

  const setMeasure = (measure: ExerciseMeasure): void => {
    const equipment = input.measure === measure ? input.equipment : exercise === null ? defaultEquipment(measure) : input.equipment;
    setInput({ ...input, measure, equipment, loadStepGrams: usesLoad(measure) ? (input.loadStepGrams ?? defaultStep(equipment, massUnit)) : null });
  };
  const setEquipment = (equipment: Equipment): void => {
    setInput({ ...input, equipment, loadStepGrams: usesLoad(input.measure) ? (stepTouched ? input.loadStepGrams : defaultStep(equipment, massUnit)) : null });
  };
  const toggleZone = (zone: ZoneKey): void => {
    setInput({ ...input, zones: input.zones.includes(zone) ? input.zones.filter((entry) => entry !== zone) : [...input.zones, zone] });
  };

  const save = (): void => {
    if (exercise === null) {
      const plan = planCreateExercise(input, exercises, environment.newId);
      if (!plan.ok) return;
      write(`Exercice créé : ${input.name.trim()}`, plan.mutations);
      onDone(plan.exerciseId);
      return;
    }
    const plan = planUpdateExercise({ exercise, zones: exerciseZones, inUse: usage.inUse, input }, exercises);
    if (!plan.ok) return;
    if (plan.mutations.length > 0) write(`Exercice modifié : ${input.name.trim()}`, plan.mutations);
    onDone(exercise.id);
  };

  const useExisting = (existing: Exercise): void => {
    const restore = planRestoreExercise(existing);
    if (restore !== null) write(`Exercice restauré : ${existing.name}`, [restore]);
    onDone(existing.id);
  };

  const archive = (): void => {
    if (exercise === null) return;
    const mutation = planArchiveExercise(exercise, environment.now());
    if (mutation !== null) write(`Exercice archivé : ${exercise.name}`, [mutation]);
    onArchived();
  };

  return (
    <View>
      <TextField
        value={input.name}
        onChangeText={(name) => setInput({ ...input, name })}
        placeholder="Nom de l'exercice"
        accessibilityLabel="Nom de l'exercice"
        autoFocus={exercise === null && initialName === ""}
        autoCapitalize="sentences"
      />
      {taken === null ? null : (
        <Panel style={[styles.taken, { backgroundColor: colors.surface2 }]}>
          <Text variant="bodyStrong">« {taken.name} » existe déjà</Text>
          <Text variant="small" tone="secondary">
            {taken.archivedAt === null ? `${equipmentLabels[taken.equipment]} · ${measureLabels[taken.measure]}` : "archivé"}
          </Text>
          {exercise === null ? <ControlButton label={taken.archivedAt === null ? "Utiliser celui-ci" : "Restaurer et utiliser"} onPress={() => useExisting(taken)} style={styles.takenAction} /> : null}
        </Panel>
      )}
      <Question title="Mesure" {...(measureLocked ? { hint: "déjà utilisé, mesure fixée" } : {})}>
        {measureLocked ? (
          <Text variant="bodyStrong">{measureLabels[input.measure]}</Text>
        ) : (
          <Segmented<ExerciseMeasure> options={exerciseMeasures.map((measure) => ({ value: measure, label: measureLabels[measure] }))} value={input.measure} onChange={setMeasure} />
        )}
      </Question>
      <Question title="Matériel">
        <Chips<Equipment>
          label="Matériel"
          multiple={false}
          options={equipments.map((equipment) => ({ value: equipment, label: equipmentLabels[equipment] }))}
          selected={[input.equipment]}
          onToggle={setEquipment}
        />
      </Question>
      {usesLoad(input.measure) ? (
        <Question title="Pas de charge" hint={`écart entre deux charges, en ${massUnit}`}>
          <Scale<number>
            label="Pas de charge"
            words
            options={loadSteps[massUnit].map((grams) => ({ value: grams, label: formatLoadStep(grams, massUnit).replace(/ (kg|lb)$/, "") }))}
            value={input.loadStepGrams}
            onChange={(grams) => {
              setStepTouched(true);
              setInput({ ...input, loadStepGrams: grams });
            }}
          />
        </Question>
      ) : null}
      <Question title="Zones sollicitées" hint="pour relier les douleurs">
        <Chips<ZoneKey>
          label="Zones sollicitées"
          multiple
          options={zoneKeys.filter((zone) => !("retired" in zoneCatalog[zone])).map((zone) => ({ value: zone, label: zoneCatalog[zone].label }))}
          selected={input.zones}
          onToggle={toggleZone}
        />
      </Question>
      {exercise !== null && !exercise.zonesReviewed ? (
        <Text variant="small" tone="secondary" style={styles.note}>
          Zones proposées par l'agent : vérifie-les puis enregistre.
        </Text>
      ) : null}
      <SheetButton label={exercise === null ? "Créer l'exercice" : "Enregistrer"} disabled={input.name.trim() === "" || taken !== null} onPress={save} style={styles.save} />
      {exercise === null || exercise.archivedAt !== null ? null : (
        <View style={styles.archive}>
          {usage.programNames.length === 0 ? null : (
            <Text variant="small" tone="secondary">
              Utilisé dans {usage.programNames.join(", ")}. Archivé, il restera dans les versions publiées mais devra être remplacé à la prochaine modification.
            </Text>
          )}
          <ControlButton label="Archiver l'exercice" onPress={archive} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  taken: { marginTop: 10, gap: 4 },
  takenAction: { marginTop: 8 },
  note: { marginTop: 12 },
  save: { marginTop: 20 },
  archive: { marginTop: 12, gap: 8 },
});
