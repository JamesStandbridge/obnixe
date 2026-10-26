import type { ChoiceFilter, FieldValues, GradeValue, IndicatorDefinition, Operand, SportDefinition } from "@obnixe/schema";
import { parseGrade } from "../stats/indicators.ts";
import type { Grade } from "../stats/indicators.ts";

export type IndicatorResult =
  | { readonly kind: "number"; readonly key: string; readonly label: string; readonly value: number }
  | { readonly kind: "grade"; readonly key: string; readonly label: string; readonly value: GradeValue };

export interface IndicatorInput {
  readonly durationSeconds: number;
  readonly values: FieldValues;
  readonly items: readonly FieldValues[];
}

function matches(values: FieldValues, filter: ChoiceFilter | null): boolean {
  if (filter === null) return true;
  const value = values[filter.field];
  if (typeof value === "string") return filter.anyOf.includes(value);
  if (Array.isArray(value)) return value.some((option) => filter.anyOf.includes(option));
  return false;
}

function operand(input: IndicatorInput, name: Operand): number | null {
  if (name === "duration") return input.durationSeconds;
  const value = input.values[name];
  return typeof value === "number" ? value : null;
}

function aggregateNumbers(values: readonly number[], fn: "sum" | "max" | "min" | "average"): number | null {
  if (values.length === 0) return null;
  switch (fn) {
    case "sum":
      return values.reduce((total, value) => total + value, 0);
    case "max":
      return Math.max(...values);
    case "min":
      return Math.min(...values);
    case "average":
      return values.reduce((total, value) => total + value, 0) / values.length;
    default: {
      const unreachable: never = fn;
      throw new Error(`Unhandled aggregate ${String(unreachable)}`);
    }
  }
}

function aggregateGrades(values: readonly Grade[], fn: "sum" | "max" | "min" | "average"): GradeValue | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left.index - right.index);
  switch (fn) {
    case "max": {
      const best = sorted.at(-1);
      return best === undefined ? null : (`${best.scale}:${best.label}` as GradeValue);
    }
    case "min": {
      const lowest = sorted[0];
      return lowest === undefined ? null : (`${lowest.scale}:${lowest.label}` as GradeValue);
    }
    case "sum":
    case "average":
      return null;
    default: {
      const unreachable: never = fn;
      throw new Error(`Unhandled aggregate ${String(unreachable)}`);
    }
  }
}

function evaluate(definition: IndicatorDefinition, input: IndicatorInput): IndicatorResult | null {
  const base = { key: definition.key, label: definition.label };
  switch (definition.type) {
    case "aggregate": {
      const sources = definition.scope === "session" ? [input.values] : input.items.filter((item) => matches(item, definition.filter));
      const raw = sources.map((values) => values[definition.field]).filter((value) => value !== undefined);
      const grades = raw.map(parseGrade).filter((grade): grade is Grade => grade !== null);
      if (grades.length > 0) {
        const value = aggregateGrades(grades, definition.fn);
        return value === null ? null : { kind: "grade", ...base, value };
      }
      const value = aggregateNumbers(raw.filter((item): item is number => typeof item === "number"), definition.fn);
      return value === null ? null : { kind: "number", ...base, value };
    }
    case "count":
      return { kind: "number", ...base, value: input.items.filter((item) => matches(item, definition.filter)).length };
    case "share":
      if (input.items.length === 0) return null;
      return { kind: "number", ...base, value: input.items.filter((item) => matches(item, definition.filter)).length / input.items.length };
    case "ratio": {
      const numerator = operand(input, definition.numerator);
      const denominator = operand(input, definition.denominator);
      if (numerator === null || denominator === null || numerator <= 0 || denominator <= 0) return null;
      return { kind: "number", ...base, value: (numerator / denominator) * definition.per };
    }
    default: {
      const unreachable: never = definition;
      throw new Error(`Unhandled indicator ${JSON.stringify(unreachable)}`);
    }
  }
}

export function evaluateIndicators(sport: SportDefinition, input: IndicatorInput): IndicatorResult[] {
  return sport.indicators.map((definition) => evaluate(definition, input)).filter((result): result is IndicatorResult => result !== null);
}
