import type { MassUnit } from "@obnixe/schema";

export const gramsPerPound = 453.59237;

const poundSteps = [0.5, 1, 1.25, 2.5, 5, 10, 25] as const;

export function gramsToMass(grams: number, unit: MassUnit): number {
  switch (unit) {
    case "kg":
      return Math.round(grams / 100) / 10;
    case "lb":
      return Math.round((grams / gramsPerPound) * 10) / 10;
    default: {
      const unreachable: never = unit;
      throw new Error(`Unhandled mass unit ${String(unreachable)}`);
    }
  }
}

export function massToGrams(value: number, unit: MassUnit): number {
  switch (unit) {
    case "kg":
      return Math.round(value * 1000);
    case "lb":
      return Math.round(value * gramsPerPound);
    default: {
      const unreachable: never = unit;
      throw new Error(`Unhandled mass unit ${String(unreachable)}`);
    }
  }
}

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
