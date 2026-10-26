import type { ClimbDiscipline, ClimbResult, ClimbStyle, ClimbSummary } from "@obnixe/core";
import { parseGrade } from "@obnixe/core";
import type { GradeScaleKey } from "@obnixe/schema";

export interface ClimbNoun {
  readonly one: string;
  readonly many: string;
  readonly the: string;
  readonly of: string;
  readonly first: string;
  readonly this: string;
  readonly done: (participle: string) => string;
}

const boulder: ClimbNoun = { one: "bloc", many: "blocs", the: "le bloc", of: "du bloc", first: "le premier bloc", this: "ce bloc", done: (participle) => participle };
const route: ClimbNoun = { one: "voie", many: "voies", the: "la voie", of: "de la voie", first: "la première voie", this: "cette voie", done: (participle) => `${participle}e` };

export const disciplineLabels: Readonly<Record<ClimbDiscipline, string>> = { boulder: "Bloc", lead: "Voie en tête", top_rope: "Moulinette", board: "Pan" };

export const resultLabels: Readonly<Record<ClimbResult, string>> = { flash: "Flash", sent: "Enchaîné", project: "Pas encore" };

export const styleLabels: Readonly<Record<ClimbStyle, string>> = { overhang: "Dévers", slab: "Dalle", crimps: "Réglettes", dyno: "Jeté" };

export const scaleShortLabels: Readonly<Record<GradeScaleKey, string>> = { fontainebleau: "Font", french: "Fr" };

export function nounFor(discipline: ClimbDiscipline): ClimbNoun {
  switch (discipline) {
    case "boulder":
    case "board":
      return boulder;
    case "lead":
    case "top_rope":
      return route;
    default: {
      const unreachable: never = discipline;
      return unreachable;
    }
  }
}

export function itemTitle(noun: ClimbNoun, number: number): string {
  return `${noun.one.charAt(0).toUpperCase()}${noun.one.slice(1)} ${number}`;
}

export function countLabel(noun: ClimbNoun, count: number): string {
  return `${count} ${count > 1 ? noun.many : noun.one}`;
}

export function summaryText(noun: ClimbNoun, summary: ClimbSummary): string {
  const best = parseGrade(summary.maxSent ?? undefined);
  return `${countLabel(noun, summary.count)} · max enchaîné ${best === null ? "–" : best.label} · ${summary.flashes} flash`;
}

export function cellText(result: ClimbResult, attempts: number): string {
  switch (result) {
    case "flash":
      return "flash";
    case "sent":
      return attempts > 1 ? `${attempts} essais` : "1 essai";
    case "project":
      return `pas encore · ${attempts}`;
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}
