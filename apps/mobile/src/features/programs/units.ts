import type { Dimension, SportKey } from "@obnixe/schema";

export function formatDecimal(value: number, digits = 2): string {
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
  return String(rounded).replace(".", ",");
}

export interface QuantityUnit {
  readonly unit: string;
  readonly factor: number;
  readonly decimals: number;
}

export function quantityUnit(dimension: Dimension, key: string, sport: SportKey): QuantityUnit {
  switch (dimension) {
    case "distance":
      return key === "distance" && sport !== "swim" ? { unit: "km", factor: 1000, decimals: 2 } : { unit: "m", factor: 1, decimals: 0 };
    case "mass":
      return { unit: "kg", factor: 1000, decimals: 1 };
    case "length":
      return { unit: "cm", factor: 10, decimals: 1 };
    case "duration":
      return { unit: "min", factor: 60, decimals: 0 };
    case "count":
      return { unit: "", factor: 1, decimals: 0 };
    case "heart_rate":
      return { unit: "bpm", factor: 1, decimals: 0 };
    case "power":
      return { unit: "W", factor: 1, decimals: 0 };
    default: {
      const unreachable: never = dimension;
      return unreachable;
    }
  }
}

export function formatQuantity(value: number, unit: QuantityUnit): string {
  const display = formatDecimal(value / unit.factor, unit.decimals);
  return unit.unit === "" ? display : `${display} ${unit.unit}`;
}

export function padValue(value: number, unit: QuantityUnit): string {
  return formatDecimal(value / unit.factor, unit.decimals);
}
