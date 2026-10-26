import { z } from "zod";
import { gradeScales } from "./catalog/grades.ts";
import type { GradeScaleKey } from "./catalog/grades.ts";
import type { Dimension } from "./enums.ts";

interface FieldBase {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly emphasis: boolean;
  readonly retired?: true;
}

export interface ChoiceOption {
  readonly key: string;
  readonly label: string;
  readonly retired?: true;
}

export type FieldDefinition =
  | (FieldBase & { readonly type: "quantity"; readonly dimension: Dimension; readonly min: number | null; readonly max: number | null })
  | (FieldBase & { readonly type: "grade"; readonly scales: readonly [GradeScaleKey, ...GradeScaleKey[]] })
  | (FieldBase & { readonly type: "choice"; readonly multiple: boolean; readonly options: readonly [ChoiceOption, ...ChoiceOption[]] })
  | (FieldBase & { readonly type: "text" })
  | (FieldBase & { readonly type: "toggle" });

export const fieldValue = z.union([z.int(), z.string(), z.array(z.string()), z.boolean()]);
export type FieldValue = z.infer<typeof fieldValue>;

export const fieldValues = z.record(z.string(), fieldValue);
export type FieldValues = z.infer<typeof fieldValues>;

export interface ChoiceFilter {
  readonly field: string;
  readonly anyOf: readonly [string, ...string[]];
}

export type Operand = "duration" | (string & {});

export type IndicatorDefinition =
  | { readonly type: "aggregate"; readonly key: string; readonly label: string; readonly scope: "session" | "item"; readonly field: string; readonly fn: "sum" | "max" | "min" | "average"; readonly filter: ChoiceFilter | null }
  | { readonly type: "count"; readonly key: string; readonly label: string; readonly filter: ChoiceFilter | null }
  | { readonly type: "share"; readonly key: string; readonly label: string; readonly filter: ChoiceFilter }
  | { readonly type: "ratio"; readonly key: string; readonly label: string; readonly numerator: Operand; readonly denominator: Operand; readonly per: number };

export type GradeValue = `${GradeScaleKey}:${string}`;

export function gradeValue(scale: GradeScaleKey, grade: string): GradeValue {
  return `${scale}:${grade}`;
}

export function valuesSchema(definitions: readonly FieldDefinition[]): z.ZodType<FieldValues> {
  const shape: Record<string, z.ZodType<FieldValue | undefined>> = {};
  for (const definition of definitions) {
    const schema = valueSchema(definition);
    shape[definition.key] = definition.required ? schema : schema.optional();
  }
  return z.strictObject(shape) as unknown as z.ZodType<FieldValues>;
}

function valueSchema(definition: FieldDefinition): z.ZodType<FieldValue> {
  switch (definition.type) {
    case "quantity": {
      let schema = z.int().nonnegative();
      if (definition.min !== null) schema = schema.min(definition.min);
      if (definition.max !== null) schema = schema.max(definition.max);
      return schema;
    }
    case "grade":
      return z.enum(definition.scales.flatMap((scale) => gradeScales[scale].grades.map((grade) => gradeValue(scale, grade))) as [string, ...string[]]);
    case "choice": {
      const keys = definition.options.map((option) => option.key) as [string, ...string[]];
      return definition.multiple ? z.array(z.enum(keys)) : z.enum(keys);
    }
    case "text":
      return z.string().trim().min(1);
    case "toggle":
      return z.boolean();
    default: {
      const unreachable: never = definition;
      throw new Error(`Unhandled field type ${JSON.stringify(unreachable)}`);
    }
  }
}
