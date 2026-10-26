import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gradeValue } from "../fields.ts";
import { catalogSignature, signatureBreaks } from "./signature.ts";
import type { CatalogSnapshot } from "./signature.ts";
import { catalogVersion, itemValuesSchema, sports } from "./sports.ts";
import type { SportDefinition } from "./sports.ts";

const snapshot = JSON.parse(readFileSync(new URL("../../catalog.snapshot.json", import.meta.url), "utf8")) as CatalogSnapshot;

describe("catalog", () => {
  it("keeps every published key with the same shape", () => {
    expect(signatureBreaks(snapshot.paths, catalogSignature())).toEqual([]);
  });

  it("has no unpublished key", () => {
    expect(Object.keys(catalogSignature()).filter((path) => !(path in snapshot.paths))).toEqual([]);
  });

  it("publishes the current catalog version", () => {
    expect(snapshot.version).toBe(catalogVersion);
  });

  it.each(Object.entries(sports) as [string, SportDefinition][])("%s is consistent", (_, sport) => {
    const fields = [...sport.sessionFields, ...sport.itemFields];
    const keys = new Set(fields.map((field) => field.key));
    expect(keys.size).toBe(fields.length);
    expect(sport.itemLabel === null).toBe(sport.itemFields.length === 0);
    for (const indicator of sport.indicators) {
      const references = indicator.type === "ratio" ? [indicator.numerator, indicator.denominator] : indicator.type === "aggregate" ? [indicator.field] : [];
      const filter = indicator.type === "ratio" ? null : indicator.filter;
      for (const reference of [...references, ...(filter === null ? [] : [filter.field])]) expect(reference === "duration" || keys.has(reference)).toBe(true);
    }
    if (sport.gradeScaleBy !== null) {
      const discipline = sport.sessionFields.find((field) => field.key === sport.gradeScaleBy?.field);
      expect(discipline?.type).toBe("choice");
      if (discipline?.type === "choice") expect(discipline.options.map((option) => option.key).sort()).toEqual(Object.keys(sport.gradeScaleBy.scales).sort());
    }
  });

  it("grades a climb with the scale of its discipline", () => {
    const boulder = itemValuesSchema(sports.climb, { discipline: "boulder" });
    expect(boulder.safeParse({ grade: gradeValue("fontainebleau", "6B"), attempts: 2, result: "sent" }).success).toBe(true);
    expect(boulder.safeParse({ grade: gradeValue("french", "6b"), attempts: 2, result: "sent" }).success).toBe(false);
  });
});
