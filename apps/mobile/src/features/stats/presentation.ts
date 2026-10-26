import { indicatorOver, matchesFilter } from "@obnixe/core";
import type { IndicatorValue, SessionSummary } from "@obnixe/core";
import { sports } from "@obnixe/schema";
import type { FieldDefinition, FieldValue, FieldValues, IndicatorDefinition, SportDefinition, SportKey } from "@obnixe/schema";
import { durationFigure, effortLabel, formatInteger, formatKilometers, formatMinutesSeconds, formatNumber, lowerFirst, plural } from "@/features/stats/format";
import type { FigureText } from "@/features/stats/format";
import { freeStrengthTitle } from "@/features/training/sessionText";

export function sportLabel(sport: SportKey): string {
  return sports[sport].label;
}

function choiceLabel(field: FieldDefinition | undefined, value: FieldValue | undefined): string | null {
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

export function sessionTitle(summary: Pick<SessionSummary, "sport" | "title" | "slotName" | "variantName" | "values">): string {
  if (summary.title !== null) return summary.title;
  const sport: SportDefinition = sports[summary.sport];
  switch (sport.archetype) {
    case "strength":
      if (summary.slotName !== null) return summary.variantName === null ? summary.slotName : `${summary.slotName} · ${summary.variantName}`;
      return freeStrengthTitle;
    case "itemized": {
      const choice = firstChoice(sport, summary.values);
      const text = textValue(sport, summary.values);
      return [choice ?? sport.label, text].filter((part): part is string => part !== null).join(" · ");
    }
    case "continuous": {
      const text = textValue(sport, summary.values);
      const choice = firstChoice(sport, summary.values);
      const suffix = text ?? (choice === null ? null : lowerFirst(choice));
      return suffix === null ? (summary.slotName ?? sport.label) : `${sport.label} · ${suffix}`;
    }
    default: {
      const unreachable: never = sport.archetype;
      return unreachable;
    }
  }
}

function prefersMeters(sport: SportDefinition): boolean {
  return sport.indicators.some((indicator) => indicator.type === "ratio" && indicator.denominator === "distance" && indicator.per < 1000);
}

export function distanceFigure(sport: SportDefinition, meters: number): FigureText {
  return prefersMeters(sport) ? { value: formatInteger(meters), unit: "m" } : { value: formatKilometers(meters), unit: "km" };
}

export function formatRatio(indicator: Extract<IndicatorDefinition, { type: "ratio" }>, value: number): FigureText {
  if (indicator.numerator === "duration" && indicator.denominator === "distance") {
    return { value: formatMinutesSeconds(value), unit: indicator.per === 1000 ? "/km" : `/${formatInteger(indicator.per)} m` };
  }
  if (indicator.numerator === "distance" && indicator.denominator === "duration" && indicator.per === 3600) {
    return { value: formatNumber(value / 1000, 1, 1), unit: "km/h" };
  }
  return { value: formatNumber(value, 2), unit: "" };
}

function itemNoun(sport: SportKey, values: FieldValues): string {
  if (sport === "climb") return values.discipline === "lead" || values.discipline === "top_rope" ? "voie" : "bloc";
  return "passage";
}

export function indicatorText(sport: SportDefinition, indicator: IndicatorDefinition, value: IndicatorValue, session: Pick<SessionSummary, "items" | "values">): string | null {
  if (value.kind === "grade") return `${indicator.type === "aggregate" && indicator.fn === "min" ? "min" : "max"} ${value.grade.label}`;
  switch (indicator.type) {
    case "ratio": {
      const figure = formatRatio(indicator, value.value);
      return `${figure.value} ${figure.unit}`.trim();
    }
    case "share": {
      const matching = session.items.filter((item) => matchesFilter(indicator.filter, item)).length;
      if (matching === 0) return null;
      const field = [...sport.sessionFields, ...sport.itemFields].find((candidate) => candidate.key === indicator.filter.field);
      const option = indicator.filter.anyOf.length === 1 ? choiceLabel(field, indicator.filter.anyOf[0]) : null;
      return `${matching} ${option === null ? lowerFirst(indicator.label) : lowerFirst(option)}`;
    }
    case "count":
      return `${formatInteger(value.value)} ${lowerFirst(indicator.label)}`;
    case "aggregate":
      return `${lowerFirst(indicator.label)} ${formatNumber(value.value)}`;
    default: {
      const unreachable: never = indicator;
      return unreachable;
    }
  }
}

function quantityDetail(field: Extract<FieldDefinition, { type: "quantity" }>, value: number): string | null {
  switch (field.key) {
    case "elevation_gain":
      return `D+ ${formatInteger(value)} m`;
    case "pack_mass":
      return `sac ${formatNumber(value / 1000)} kg`;
    default:
      break;
  }
  switch (field.dimension) {
    case "heart_rate":
      return `${formatInteger(value)} bpm`;
    case "power":
      return `${formatInteger(value)} W`;
    case "mass":
    case "length":
    case "distance":
    case "duration":
    case "count":
      return null;
    default: {
      const unreachable: never = field.dimension;
      return unreachable;
    }
  }
}

export interface SessionFigure {
  readonly figure: FigureText | null;
  readonly details: readonly string[];
}

export function sessionFigure(summary: SessionSummary): SessionFigure {
  const sport: SportDefinition = sports[summary.sport];
  const duration = summary.durationSeconds === null ? null : durationFigure(summary.durationSeconds);
  switch (sport.archetype) {
    case "strength": {
      const details = [summary.strengthSets > 0 ? plural(summary.strengthSets, "série") : null, summary.effort === null ? null : effortLabel(summary.effort)];
      return { figure: duration, details: details.filter((part): part is string => part !== null) };
    }
    case "itemized": {
      const details: string[] = [];
      if (summary.items.length > 0) details.push(plural(summary.items.length, itemNoun(summary.sport, summary.values)));
      for (const indicator of sport.indicators) {
        const value = indicatorOver(indicator, sport, [summary]);
        const text = value === null ? null : indicatorText(sport, indicator, value, summary);
        if (text !== null) details.push(text);
      }
      return { figure: duration, details };
    }
    case "continuous": {
      const distance = summary.values.distance;
      const details: string[] = [];
      for (const indicator of sport.indicators) {
        const value = indicatorOver(indicator, sport, [summary]);
        const text = value === null ? null : indicatorText(sport, indicator, value, summary);
        if (text !== null) details.push(text);
      }
      for (const field of sport.sessionFields) {
        const value = summary.values[field.key];
        if (field.type === "quantity" && field.key !== "distance" && typeof value === "number") {
          const text = quantityDetail(field, value);
          if (text !== null) details.push(text);
        }
      }
      if (summary.note !== null && summary.note.length <= 32) details.push(summary.note);
      return { figure: typeof distance === "number" ? distanceFigure(sport, distance) : duration, details };
    }
    default: {
      const unreachable: never = sport.archetype;
      return unreachable;
    }
  }
}
