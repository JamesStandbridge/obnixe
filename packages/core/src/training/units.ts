import type { Exercise, MassUnit } from "@obnixe/schema";
import { gramsPerPound } from "../activity/catalog.ts";
import { gramsToMass, massToGrams } from "../body/weight.ts";

const poundSteps = [0.5, 1, 1.25, 2.5, 5, 10, 25] as const;

export function massStep(stepGrams: number, unit: MassUnit): number {
  switch (unit) {
    case "kg":
      return gramsToMass(stepGrams, unit);
    case "lb": {
      const pounds = stepGrams / gramsPerPound;
      return poundSteps.reduce((best, candidate) => (Math.abs(candidate - pounds) < Math.abs(best - pounds) ? candidate : best), poundSteps[0]);
    }
    default: {
      const unreachable: never = unit;
      throw new Error(`Unhandled mass unit ${String(unreachable)}`);
    }
  }
}

export function stepGramsFor(exercise: Pick<Exercise, "loadStepGrams" | "equipment">, unit: MassUnit): number {
  const grams = exercise.loadStepGrams ?? (exercise.equipment === "barbell" ? 2500 : 1000);
  return massToGrams(massStep(grams, unit), unit);
}
