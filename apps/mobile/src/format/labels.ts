import type { SessionSummary } from "@obnixe/core";
import { sports, zones } from "@obnixe/schema";
import type { FieldDefinition, FieldValue, FieldValues, SportDefinition, ZoneKey } from "@obnixe/schema";
import { formatInteger } from "@/format/numbers";

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatInteger(count)} ${count > 1 ? pluralForm : singular}`;
}

export function capitalize(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toLocaleUpperCase("fr-FR")}${text.slice(1)}`;
}

export function lowerFirst(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toLocaleLowerCase("fr-FR")}${text.slice(1)}`;
}

export function zoneLabel(zone: ZoneKey): string {
  return zones[zone].label;
}

export const freeStrengthTitle = "Musculation libre";

export type SessionTitleSource = Pick<SessionSummary, "sport" | "title" | "slotName" | "variantName" | "values">;

export function choiceLabel(field: FieldDefinition | undefined, value: FieldValue | undefined): string | null {
  if (field?.type !== "choice" || typeof value !== "string") return null;
  return field.options.find((option) => option.key === value)?.label ?? null;
}

function textValue(sport: SportDefinition, values: FieldValues): string | null {
  for (const field of sport.sessionFields) {
    const value = values[field.key];
    if (field.type === "text" && typeof value === "string") return value;
  }
  return null;
}

function firstChoice(sport: SportDefinition, values: FieldValues): string | null {
  for (const field of sport.sessionFields) {
    const label = choiceLabel(field, values[field.key]);
    if (label !== null) return label;
  }
  return null;
}

export function sessionTitle(source: SessionTitleSource): string {
  if (source.title !== null) return source.title;
  const sport: SportDefinition = sports[source.sport];
  switch (sport.archetype) {
    case "strength":
      if (source.slotName !== null) return source.variantName === null ? source.slotName : `${source.slotName} · ${source.variantName}`;
      return freeStrengthTitle;
    case "itemized": {
      const choice = firstChoice(sport, source.values);
      const text = textValue(sport, source.values);
      return [choice ?? sport.label, text].filter((part): part is string => part !== null).join(" · ");
    }
    case "continuous": {
      const text = textValue(sport, source.values);
      const choice = firstChoice(sport, source.values);
      const suffix = text ?? (choice === null ? null : lowerFirst(choice));
      return suffix === null ? (source.slotName ?? sport.label) : `${sport.label} · ${suffix}`;
    }
    default: {
      const unreachable: never = sport.archetype;
      return unreachable;
    }
  }
}
