import type { FieldDefinition } from "../fields.ts";
import { gradeScales } from "./grades.ts";
import { sports } from "./sports.ts";
import { zones } from "./zones.ts";

export type CatalogSignature = Record<string, string>;

export interface CatalogSnapshot {
  readonly version: number;
  readonly paths: CatalogSignature;
}

export function catalogSignature(): CatalogSignature {
  const signature: CatalogSignature = {};
  for (const key of Object.keys(zones)) signature[`zone:${key}`] = "zone";
  for (const [scale, { grades }] of Object.entries(gradeScales)) for (const grade of grades) signature[`grade:${scale}:${grade}`] = "grade";
  for (const [sport, definition] of Object.entries(sports)) {
    signature[`sport:${sport}`] = definition.archetype;
    for (const field of definition.sessionFields) addField(signature, sport, "session", field);
    for (const field of definition.itemFields) addField(signature, sport, "item", field);
  }
  return signature;
}

function addField(signature: CatalogSignature, sport: string, scope: "session" | "item", field: FieldDefinition): void {
  const path = `field:${sport}:${field.key}`;
  switch (field.type) {
    case "quantity":
      signature[path] = `${scope}:quantity:${field.dimension}`;
      return;
    case "grade":
      signature[path] = `${scope}:grade`;
      return;
    case "choice":
      signature[path] = `${scope}:choice:${field.multiple ? "multiple" : "single"}`;
      for (const option of field.options) signature[`option:${sport}:${field.key}:${option.key}`] = "option";
      return;
    case "text":
    case "toggle":
      signature[path] = `${scope}:${field.type}`;
      return;
    default: {
      const unreachable: never = field;
      throw new Error(`Unhandled field type ${JSON.stringify(unreachable)}`);
    }
  }
}

export function signatureBreaks(snapshot: CatalogSignature, current: CatalogSignature): string[] {
  return Object.entries(snapshot)
    .filter(([path, value]) => current[path] !== value)
    .map(([path, value]) => `${path}: ${value} -> ${current[path] ?? "missing"}`);
}
