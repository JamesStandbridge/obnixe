import { fromStored, quantityUnit } from "@obnixe/core";
import type { IndicatorResult, QuantityField, QuantityUnit } from "@obnixe/core";
import type { MassUnit, SportKey } from "@obnixe/schema";
import { formatNumber } from "@/format/numbers";

const articles: Partial<Readonly<Record<SportKey, string>>> = {
  run: "la course",
  hike: "la rando",
  swim: "la natation",
  bike: "la sortie vélo",
  yoga: "le yoga",
  ski_touring: "la sortie en ski de rando",
  nordic_ski: "le ski de fond",
  alpine_ski: "la journée de ski",
  paddle: "la sortie sur l'eau",
  inline_skate: "la sortie en roller",
};

const gearLabels: Partial<Readonly<Record<SportKey, string>>> = {
  run: "Chaussures",
  hike: "Chaussures",
  bike: "Vélo utilisé",
  ski_touring: "Skis utilisés",
  nordic_ski: "Skis utilisés",
  alpine_ski: "Skis ou planche",
  paddle: "Embarcation",
  inline_skate: "Rollers utilisés",
};

export function sportArticle(sport: SportKey): string {
  return articles[sport] ?? "l'activité";
}

export function gearLabel(sport: SportKey): string {
  return gearLabels[sport] ?? "Équipement";
}

export function formatQuantity(stored: number, unit: QuantityUnit): string {
  return formatNumber(fromStored(stored, unit), unit.decimals);
}

export function fieldUnit(sport: SportKey, field: QuantityField, massUnit: MassUnit): QuantityUnit {
  return quantityUnit(sport, field, massUnit);
}

export function formatKilometers(meters: number): string {
  return `${formatNumber(Math.round(meters / 1000), 0)} km`;
}

export function formatRatio(result: IndicatorResult): string | null {
  if (result.kind !== "number") return null;
  switch (result.key) {
    case "pace": {
      const seconds = Math.round(result.value);
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    }
    case "speed":
      return formatNumber(result.value / 1000, 1);
    default:
      return formatNumber(result.value, 1);
  }
}
