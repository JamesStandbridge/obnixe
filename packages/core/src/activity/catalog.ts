import { sports } from "@obnixe/schema";
import type { Dimension, FieldDefinition, MassUnit, SportDefinition, SportKey } from "@obnixe/schema";

export type QuantityField = Extract<FieldDefinition, { readonly type: "quantity" }>;
export type ChoiceField = Extract<FieldDefinition, { readonly type: "choice" }>;

export interface QuantityUnit {
  readonly symbol: string;
  readonly factor: number;
  readonly decimals: number;
}

export const gramsPerPound = 453.59237;

export function sportOf(key: SportKey): SportDefinition {
  return sports[key];
}

export function isFreeSport(key: SportKey): boolean {
  const sport: SportDefinition = sports[key];
  return sport.archetype === "continuous" && sport.retired !== true;
}

export function massUnitOf(unit: MassUnit): QuantityUnit {
  switch (unit) {
    case "kg":
      return { symbol: "kg", factor: 1000, decimals: 1 };
    case "lb":
      return { symbol: "lb", factor: gramsPerPound, decimals: 1 };
    default: {
      const unreachable: never = unit;
      throw new Error(`Unhandled mass unit ${String(unreachable)}`);
    }
  }
}

function dimensionUnit(dimension: Dimension, long: boolean, massUnit: MassUnit): QuantityUnit {
  switch (dimension) {
    case "distance":
      return long ? { symbol: "km", factor: 1000, decimals: 2 } : { symbol: "m", factor: 1, decimals: 0 };
    case "length":
      return { symbol: "cm", factor: 10, decimals: 1 };
    case "mass":
      return massUnitOf(massUnit);
    case "duration":
      return { symbol: "min", factor: 60, decimals: 0 };
    case "count":
      return { symbol: "", factor: 1, decimals: 0 };
    case "heart_rate":
      return { symbol: "bpm", factor: 1, decimals: 0 };
    case "power":
      return { symbol: "W", factor: 1, decimals: 0 };
    default: {
      const unreachable: never = dimension;
      throw new Error(`Unhandled dimension ${String(unreachable)}`);
    }
  }
}

export function quantityUnit(sport: SportKey, field: QuantityField, massUnit: MassUnit): QuantityUnit {
  const long = field.key === "distance" && sport !== "swim";
  return dimensionUnit(field.dimension, long, massUnit);
}

export function toStored(display: number, unit: QuantityUnit): number {
  return Math.round(display * unit.factor);
}

export function fromStored(stored: number, unit: QuantityUnit): number {
  const scale = 10 ** unit.decimals;
  return Math.round((stored / unit.factor) * scale) / scale;
}

export function emphasisQuantity(sport: SportDefinition): QuantityField | null {
  return sport.sessionFields.find((field): field is QuantityField => field.type === "quantity" && field.emphasis) ?? null;
}

export function primaryChoice(sport: SportDefinition): ChoiceField | null {
  return sport.sessionFields.find((field): field is ChoiceField => field.type === "choice" && !field.multiple && field.retired !== true) ?? null;
}
