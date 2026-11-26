import { localTimeOf } from "@obnixe/core";
import type { SessionSummary } from "@obnixe/core";
import { sports, zones } from "@obnixe/schema";
import type { FieldDefinition, FieldValue, FieldValues, Session, SportDefinition, ZoneKey } from "@obnixe/schema";
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

export interface SessionTitleSource extends Pick<Session, "sport" | "title" | "values" | "startedAt" | "timeZone"> {
  readonly slotName: string | null;
  readonly variantName: string | null;
  /** Whether a track backs the session, recorded or imported. */
  readonly recorded: boolean;
}

/** The moment of the day a recorded activity started, as its derived title says it (`REC-053`). */
export function dayMoment(source: Pick<SessionTitleSource, "startedAt" | "timeZone">): string {
  const hour = Math.floor(localTimeOf(source.startedAt, source.timeZone).minutes / 60);
  if (hour >= 5 && hour < 12) return "du matin";
  if (hour >= 12 && hour < 18) return "de l'après-midi";
  if (hour >= 18 && hour < 22) return "du soir";
  return "de nuit";
}

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

export function summaryTitle(summary: SessionSummary): string {
  return sessionTitle({ ...summary, recorded: summary.recording !== null });
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
      const label = source.recorded ? `${sport.label} ${dayMoment(source)}` : sport.label;
      return suffix === null ? (source.slotName ?? label) : `${label} · ${suffix}`;
    }
    default: {
      const unreachable: never = sport.archetype;
      return unreachable;
    }
  }
}
