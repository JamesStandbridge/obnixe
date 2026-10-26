import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { defaultLoadMode, findExerciseByName, planArchiveExercise, planCreateExercise, planRestoreExercise, planUpdateExercise, usesLoad } from "@obnixe/core";
import type { ExerciseInput, ExerciseUsage } from "@obnixe/core";
import { equipments, exerciseMeasures, loadModes, zoneKeys, zones as zoneCatalog } from "@obnixe/schema";
import type { Equipment, Exercise, ExerciseMeasure, Id, LoadMode, MassUnit, ZoneKey } from "@obnixe/schema";
import { environment } from "@/data/database";
import { write } from "@/data/write";
import { Chips } from "@/features/programs/Chips";
import { equipmentLabels, formatLoadStep, measureLabels } from "@/features/programs/format";
import { perLoadLabel } from "@/features/training/format";
import { capitalize } from "@/format/labels";
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

const baseWeights: Readonly<Record<MassUnit, readonly number[]>> = {
  kg: [5000, 7000, 10000, 15000, 20000],
  lb: [15, 25, 35, 45].map((pounds) => Math.round(pounds * poundGrams)),
};

function baseOptions(unit: MassUnit, current: number | null): readonly number[] {
  const presets = baseWeights[unit];
  return current === null || presets.includes(current) ? presets : [...presets, current].sort((left, right) => left - right);
}

function loadModeLabel(mode: LoadMode, equipment: Equipment): string {
  return capitalize(perLoadLabel({ equipment, loadMode: mode, baseGrams: null }) ?? "totale");
}

function loadModeHint(mode: LoadMode, equipment: Equipment): string {
  switch (mode) {
    case "total":
      return "telle que lue";
    case "per_hand":
      return equipment === "dumbbell" ? "un haltère, compté deux fois" : equipment === "kettlebell" ? "une kettlebell, comptée deux fois" : "une main, comptée deux fois";
    case "per_side":
      return "un côté, compté deux fois";
    default: {
      const unreachable: never = mode;
      return unreachable;
    }
  }
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
      ? { name: initialName, measure: "load_reps", equipment: "barbell", loadMode: defaultLoadMode("barbell", "load_reps"), baseGrams: null, loadStepGrams: defaultStep("barbell", massUnit), zones: [] }
      : {
          name: exercise.name,
          measure: exercise.measure,
          equipment: exercise.equipment,
          loadMode: exercise.loadMode,
          baseGrams: exercise.baseGrams,
          loadStepGrams: exercise.loadStepGrams,
          zones: exerciseZones,
        },
  );
  const [stepTouched, setStepTouched] = useState(exercise !== null);
  const [modeTouched, setModeTouched] = useState(exercise !== null);
  const taken = findExerciseByName(exercises, input.name, exercise?.id ?? null);
  const measureLocked = exercise !== null && usage.inUse;

  const loadFor = (measure: ExerciseMeasure, equipment: Equipment): Pick<ExerciseInput, "loadMode" | "baseGrams"> => {
    if (measure === "duration") return { loadMode: "total", baseGrams: null };
    return modeTouched ? { loadMode: input.loadMode, baseGrams: input.baseGrams } : { loadMode: defaultLoadMode(equipment, measure), baseGrams: null };
  };
  const setMeasure = (measure: ExerciseMeasure): void => {
    const equipment = input.measure === measure ? input.equipment : exercise === null ? defaultEquipment(measure) : input.equipment;
    setInput({ ...input, measure, equipment, ...loadFor(measure, equipment), loadStepGrams: usesLoad(measure) ? (input.loadStepGrams ?? defaultStep(equipment, massUnit)) : null });
  };
  const setEquipment = (equipment: Equipment): void => {
    setInput({ ...input, equipment, ...loadFor(input.measure, equipment), loadStepGrams: usesLoad(input.measure) ? (stepTouched ? input.loadStepGrams : defaultStep(equipment, massUnit)) : null });
  };
  const setLoadMode = (loadMode: LoadMode): void => {
    setModeTouched(true);
    setInput({ ...input, loadMode, baseGrams: loadMode === "per_side" ? input.baseGrams : null });
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
      {input.measure === "duration" ? null : (
        <Question title="Charge saisie" hint={loadModeHint(input.loadMode, input.equipment)}>
          <Segmented<LoadMode> options={loadModes.map((mode) => ({ value: mode, label: loadModeLabel(mode, input.equipment) }))} value={input.loadMode} onChange={setLoadMode} />
        </Question>
      )}
      {input.loadMode === "per_side" ? (
        <Question title={input.equipment === "barbell" ? "Barre" : "Poids à vide"} hint="compté une fois, facultatif">
          <Scale<number>
            label={input.equipment === "barbell" ? "Poids de la barre" : "Poids à vide"}
            words
            optional
            options={baseOptions(massUnit, input.baseGrams).map((grams) => ({ value: grams, label: formatLoadStep(grams, massUnit).replace(/ (kg|lb)$/, "") }))}
            value={input.baseGrams}
            onChange={(grams) => setInput({ ...input, baseGrams: grams })}
          />
        </Question>
      ) : null}
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
