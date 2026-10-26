import { gradeScales } from "@obnixe/schema";
import type { ChoiceFilter, ChoiceOption, FieldDefinition, FieldValue, FieldValues, GradeScaleKey, Id, IndicatorDefinition, LocalDate, Operand, SportDefinition } from "@obnixe/schema";
import { recordFlags } from "./series.ts";
import type { Better, Measured } from "./series.ts";

export interface Grade {
  readonly scale: GradeScaleKey;
  readonly index: number;
  readonly label: string;
}

export type IndicatorValue = { readonly kind: "number"; readonly value: number } | { readonly kind: "grade"; readonly grade: Grade };

export interface IndicatorSession {
  readonly id: Id;
  readonly localDate: LocalDate;
  readonly values: FieldValues;
  readonly items: readonly FieldValues[];
  readonly durationSeconds: number | null;
}

function isScale(value: string): value is GradeScaleKey {
  return value in gradeScales;
}

export function parseGrade(value: FieldValue | undefined): Grade | null {
  if (typeof value !== "string") return null;
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const scale = value.slice(0, separator);
  const label = value.slice(separator + 1);
  if (!isScale(scale)) return null;
  const grades: readonly string[] = gradeScales[scale].grades;
  const index = grades.indexOf(label);
  return index < 0 ? null : { scale, index, label };
}

export function gradeAt(scale: GradeScaleKey, index: number): Grade | null {
  const grades: readonly string[] = gradeScales[scale].grades;
  const label = grades[index];
  return label === undefined ? null : { scale, index, label };
}

export function matchesFilter(filter: ChoiceFilter | null, values: FieldValues): boolean {
  if (filter === null) return true;
  const value = values[filter.field];
  if (typeof value === "string") return filter.anyOf.includes(value);
  if (Array.isArray(value)) return value.some((option) => filter.anyOf.includes(option));
  return false;
}

function isItemField(sport: SportDefinition, key: string): boolean {
  return sport.itemFields.some((field) => field.key === key);
}

function fieldOf(sport: SportDefinition, key: string): FieldDefinition | undefined {
  return [...sport.sessionFields, ...sport.itemFields].find((field) => field.key === key);
}

function numberOf(value: FieldValue | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function operandOf(operand: Operand, session: IndicatorSession): number | null {
  if (operand === "duration") return session.durationSeconds;
  return numberOf(session.values[operand]);
}

type Aggregate = Extract<IndicatorDefinition, { type: "aggregate" }>;

function dominantScale(grades: readonly Grade[]): GradeScaleKey | null {
  const counts = new Map<GradeScaleKey, number>();
  for (const grade of grades) counts.set(grade.scale, (counts.get(grade.scale) ?? 0) + 1);
  let winner: GradeScaleKey | null = null;
  let winnerCount = 0;
  for (const [scale, count] of counts) {
    if (count > winnerCount) {
      winner = scale;
      winnerCount = count;
    }
  }
  return winner;
}

function aggregate(definition: Aggregate, sport: SportDefinition, rows: readonly FieldValues[]): IndicatorValue | null {
  const field = fieldOf(sport, definition.field);
  const matching = rows.filter((row) => matchesFilter(definition.filter, row));
  if (field?.type === "grade") {
    const grades = matching.map((row) => parseGrade(row[definition.field])).filter((grade): grade is Grade => grade !== null);
    const scale = dominantScale(grades);
    const sameScale = grades.filter((grade) => grade.scale === scale);
    if (scale === null || sameScale.length === 0) return null;
    const indexes = sameScale.map((grade) => grade.index);
    const index = (() => {
      switch (definition.fn) {
        case "max":
          return Math.max(...indexes);
        case "min":
          return Math.min(...indexes);
        case "average":
          return Math.round(indexes.reduce((sum, value) => sum + value, 0) / indexes.length);
        case "sum":
          return null;
        default: {
          const unreachable: never = definition.fn;
          throw new Error(`Unhandled aggregate ${String(unreachable)}`);
        }
      }
    })();
    const grade = index === null ? null : gradeAt(scale, index);
    return grade === null ? null : { kind: "grade", grade };
  }
  const numbers = matching.map((row) => numberOf(row[definition.field])).filter((value): value is number => value !== null);
  if (numbers.length === 0) return null;
  switch (definition.fn) {
    case "sum":
      return { kind: "number", value: numbers.reduce((sum, value) => sum + value, 0) };
    case "max":
      return { kind: "number", value: Math.max(...numbers) };
    case "min":
      return { kind: "number", value: Math.min(...numbers) };
    case "average":
      return { kind: "number", value: numbers.reduce((sum, value) => sum + value, 0) / numbers.length };
    default: {
      const unreachable: never = definition.fn;
      throw new Error(`Unhandled aggregate ${String(unreachable)}`);
    }
  }
}

function countable(sport: SportDefinition, filter: ChoiceFilter | null, sessions: readonly IndicatorSession[]): readonly FieldValues[] {
  const itemLevel = filter === null ? sport.itemFields.length > 0 : isItemField(sport, filter.field);
  return itemLevel ? sessions.flatMap((item) => item.items) : sessions.map((item) => item.values);
}

export function indicatorOver(definition: IndicatorDefinition, sport: SportDefinition, sessions: readonly IndicatorSession[]): IndicatorValue | null {
  if (sessions.length === 0) return null;
  switch (definition.type) {
    case "aggregate":
      return aggregate(definition, sport, definition.scope === "item" ? sessions.flatMap((item) => item.items) : sessions.map((item) => item.values));
    case "count":
      return { kind: "number", value: countable(sport, definition.filter, sessions).filter((row) => matchesFilter(definition.filter, row)).length };
    case "share": {
      const rows = countable(sport, definition.filter, sessions);
      if (rows.length === 0) return null;
      return { kind: "number", value: rows.filter((row) => matchesFilter(definition.filter, row)).length / rows.length };
    }
    case "ratio": {
      let numerator = 0;
      let denominator = 0;
      for (const item of sessions) {
        const top = operandOf(definition.numerator, item);
        const bottom = operandOf(definition.denominator, item);
        if (top === null || bottom === null || bottom === 0) continue;
        numerator += top;
        denominator += bottom;
      }
      return denominator === 0 ? null : { kind: "number", value: (numerator / denominator) * definition.per };
    }
    default: {
      const unreachable: never = definition;
      throw new Error(`Unhandled indicator ${JSON.stringify(unreachable)}`);
    }
  }
}

export function indicatorBetter(definition: IndicatorDefinition): Better {
  switch (definition.type) {
    case "aggregate":
      return definition.fn === "min" ? "lower" : "higher";
    case "count":
    case "share":
      return "higher";
    case "ratio":
      if (definition.numerator === "duration") return "lower";
      if (definition.denominator === "duration") return "higher";
      return null;
    default: {
      const unreachable: never = definition;
      throw new Error(`Unhandled indicator ${JSON.stringify(unreachable)}`);
    }
  }
}

export interface IndicatorPoint extends Measured {
  readonly sessionId: Id;
  readonly grade: Grade | null;
  readonly isRecord: boolean;
}

export function indicatorSeries(definition: IndicatorDefinition, sport: SportDefinition, sessions: readonly IndicatorSession[]): IndicatorPoint[] {
  const raw = sessions.flatMap((item) => {
    const value = indicatorOver(definition, sport, [item]);
    if (value === null) return [];
    return [{ sessionId: item.id, date: item.localDate, value: value.kind === "number" ? value.value : value.grade.index, grade: value.kind === "grade" ? value.grade : null, unreliable: false }];
  });
  const scale = dominantScale(raw.flatMap((point) => (point.grade === null ? [] : [point.grade])));
  const points = scale === null ? raw : raw.filter((point) => point.grade?.scale === scale);
  const records = recordFlags(points, indicatorBetter(definition));
  return points.map((point, index) => ({ ...point, isRecord: records[index] ?? false }));
}

export interface PyramidLevel {
  readonly grade: Grade;
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
}

export interface GradePyramid {
  readonly scale: GradeScaleKey;
  readonly options: readonly ChoiceOption[];
  readonly levels: readonly PyramidLevel[];
}

export function hasGradePyramid(sport: SportDefinition): boolean {
  return sport.itemFields.some((field) => field.type === "grade");
}

export function gradePyramid(sport: SportDefinition, sessions: readonly IndicatorSession[]): GradePyramid | null {
  const gradeField = sport.itemFields.find((field) => field.type === "grade");
  if (gradeField === undefined) return null;
  const resultField = sport.itemFields.find((field): field is Extract<FieldDefinition, { type: "choice" }> => field.type === "choice" && !field.multiple);
  const entries = sessions
    .flatMap((item) => item.items)
    .map((values) => ({ grade: parseGrade(values[gradeField.key]), result: resultField === undefined ? null : values[resultField.key] }))
    .filter((entry): entry is { grade: Grade; result: FieldValue | null | undefined } => entry.grade !== null);
  const scale = dominantScale(entries.map((entry) => entry.grade));
  if (scale === null) return null;
  const options = resultField?.options.filter((option) => option.retired !== true) ?? [];
  const byIndex = new Map<number, Record<string, number>>();
  for (const entry of entries) {
    if (entry.grade.scale !== scale) continue;
    const counts = byIndex.get(entry.grade.index) ?? {};
    const key = typeof entry.result === "string" ? entry.result : "";
    counts[key] = (counts[key] ?? 0) + 1;
    byIndex.set(entry.grade.index, counts);
  }
  const levels = [...byIndex.entries()]
    .sort(([left], [right]) => right - left)
    .flatMap(([index, counts]) => {
      const grade = gradeAt(scale, index);
      return grade === null ? [] : [{ grade, counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) }];
    });
  return { scale, options, levels };
}
