import type { Equipment, Exercise, ExerciseMeasure, LoadMode } from "@obnixe/schema";

export type ExerciseLoad = Pick<Exercise, "loadMode" | "baseGrams">;

/** Total external load moved by a set, from the value the user entered: per_hand counts two implements, per_side two sides plus the fixed base. */
export function totalLoadGrams(loadGrams: number | null, load: ExerciseLoad): number | null {
  if (loadGrams === null) return null;
  const mode = load.loadMode;
  switch (mode) {
    case "total":
      return loadGrams;
    case "per_hand":
      return loadGrams * 2;
    case "per_side":
      return loadGrams * 2 + (load.baseGrams ?? 0);
    default: {
      const unreachable: never = mode;
      throw new Error(`Unhandled load mode ${String(unreachable)}`);
    }
  }
}

export function defaultLoadMode(equipment: Equipment, measure: ExerciseMeasure): LoadMode {
  if (measure === "duration") return "total";
  switch (equipment) {
    case "dumbbell":
    case "kettlebell":
      return "per_hand";
    case "barbell":
    case "machine":
    case "cable":
    case "bodyweight":
    case "band":
    case "other":
      return "total";
    default: {
      const unreachable: never = equipment;
      throw new Error(`Unhandled equipment ${String(unreachable)}`);
    }
  }
}
