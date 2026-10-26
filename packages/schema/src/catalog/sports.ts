import type { Archetype } from "../enums.ts";
import { valuesSchema } from "../fields.ts";
import type { ChoiceOption, FieldDefinition, FieldValues, IndicatorDefinition } from "../fields.ts";
import type { z } from "zod";
import type { GradeScaleKey } from "./grades.ts";
import type { ZoneKey } from "./zones.ts";

export interface SportDefinition {
  readonly label: string;
  readonly icon: string;
  readonly archetype: Archetype;
  readonly sessionFields: readonly FieldDefinition[];
  readonly itemLabel: string | null;
  readonly itemFields: readonly FieldDefinition[];
  readonly indicators: readonly IndicatorDefinition[];
  readonly painZones: readonly ZoneKey[];
  readonly usesGear: boolean;
  readonly gradeScaleBy: { readonly field: string; readonly scales: Readonly<Record<string, GradeScaleKey>> } | null;
  readonly retired?: true;
}

const optional = { required: false, emphasis: false } as const;

const kind = (label: string, options: readonly [ChoiceOption, ...ChoiceOption[]]): FieldDefinition => ({ key: "kind", label, type: "choice", multiple: false, options, ...optional });
const distance: FieldDefinition = { key: "distance", label: "Distance", type: "quantity", dimension: "distance", min: null, max: null, required: false, emphasis: true };
const elevationGain: FieldDefinition = { key: "elevation_gain", label: "Dénivelé positif", type: "quantity", dimension: "distance", min: null, max: null, ...optional };
const heartRate: FieldDefinition = { key: "heart_rate_avg", label: "Fréquence cardiaque moyenne", type: "quantity", dimension: "heart_rate", min: 30, max: 240, ...optional };
const place: FieldDefinition = { key: "place", label: "Lieu", type: "text", ...optional };
const pace = (label: string, per: number): IndicatorDefinition => ({ type: "ratio", key: "pace", label, numerator: "duration", denominator: "distance", per });
const speed: IndicatorDefinition = { type: "ratio", key: "speed", label: "Vitesse moyenne", numerator: "distance", denominator: "duration", per: 3600 };

export const sports = {
  strength: {
    label: "Musculation",
    icon: "lift",
    archetype: "strength",
    sessionFields: [],
    itemLabel: null,
    itemFields: [],
    indicators: [],
    painZones: ["shoulder_right", "shoulder_left", "elbow_right", "elbow_left", "lower_back", "knee_right", "knee_left"],
    usesGear: false,
    gradeScaleBy: null,
  },
  run: {
    label: "Course",
    icon: "run",
    archetype: "continuous",
    sessionFields: [
      kind("Type de sortie", [{ key: "easy", label: "Footing" }, { key: "intervals", label: "Fractionné" }, { key: "trail", label: "Trail" }, { key: "long", label: "Longue" }]),
      distance,
      elevationGain,
      heartRate,
    ],
    itemLabel: null,
    itemFields: [],
    indicators: [pace("Allure", 1000)],
    painZones: ["knee_right", "knee_left", "ankle_right", "ankle_left", "achilles_right", "achilles_left", "hip_right", "hip_left"],
    usesGear: true,
    gradeScaleBy: null,
  },
  hike: {
    label: "Rando",
    icon: "hike",
    archetype: "continuous",
    sessionFields: [
      kind("Terrain", [{ key: "trail", label: "Sentier" }, { key: "mountain", label: "Montagne" }, { key: "off_trail", label: "Hors sentier" }, { key: "snow", label: "Neige" }]),
      distance,
      elevationGain,
      { key: "pack_mass", label: "Poids du sac", type: "quantity", dimension: "mass", min: null, max: null, ...optional },
      { key: "route", label: "Itinéraire", type: "text", ...optional },
    ],
    itemLabel: null,
    itemFields: [],
    indicators: [speed],
    painZones: ["knee_right", "knee_left", "ankle_right", "ankle_left", "lower_back"],
    usesGear: true,
    gradeScaleBy: null,
  },
  swim: {
    label: "Natation",
    icon: "swim",
    archetype: "continuous",
    sessionFields: [
      kind("Nage principale", [{ key: "crawl", label: "Crawl" }, { key: "breaststroke", label: "Brasse" }, { key: "mixed", label: "Mixte" }, { key: "drills", label: "Éducatifs" }]),
      distance,
      { key: "pool_length", label: "Bassin", type: "quantity", dimension: "distance", min: 10, max: 100, ...optional },
      { key: "lengths", label: "Longueurs", type: "quantity", dimension: "count", min: 1, max: null, ...optional },
      { key: "equipment", label: "Matériel", type: "text", ...optional },
    ],
    itemLabel: null,
    itemFields: [],
    indicators: [pace("Allure", 100)],
    painZones: ["shoulder_right", "shoulder_left", "neck"],
    usesGear: false,
    gradeScaleBy: null,
  },
  bike: {
    label: "Vélo",
    icon: "bike",
    archetype: "continuous",
    sessionFields: [
      kind("Type", [{ key: "road", label: "Route" }, { key: "mtb", label: "VTT" }, { key: "commute", label: "Trajet" }, { key: "indoor", label: "Home trainer" }]),
      distance,
      elevationGain,
      { key: "power_avg", label: "Puissance moyenne", type: "quantity", dimension: "power", min: null, max: null, ...optional },
    ],
    itemLabel: null,
    itemFields: [],
    indicators: [speed],
    painZones: ["knee_right", "knee_left", "lower_back", "neck"],
    usesGear: true,
    gradeScaleBy: null,
  },
  climb: {
    label: "Escalade",
    icon: "climb",
    archetype: "itemized",
    sessionFields: [
      place,
      { key: "discipline", label: "Discipline", type: "choice", multiple: false, options: [{ key: "boulder", label: "Bloc" }, { key: "lead", label: "Voie en tête" }, { key: "top_rope", label: "Moulinette" }, { key: "board", label: "Pan" }], required: true, emphasis: false },
    ],
    itemLabel: "Bloc ou voie",
    itemFields: [
      { key: "grade", label: "Cotation", type: "grade", scales: ["fontainebleau", "french"], required: true, emphasis: true },
      { key: "attempts", label: "Essais", type: "quantity", dimension: "count", min: 1, max: null, required: true, emphasis: true },
      { key: "result", label: "Résultat", type: "choice", multiple: false, options: [{ key: "flash", label: "Flash" }, { key: "sent", label: "Enchaîné" }, { key: "project", label: "Pas encore" }], required: true, emphasis: false },
      { key: "style", label: "Style", type: "choice", multiple: true, options: [{ key: "overhang", label: "Dévers" }, { key: "slab", label: "Dalle" }, { key: "crimps", label: "Réglettes" }, { key: "dyno", label: "Jeté" }], ...optional },
    ],
    indicators: [
      { type: "aggregate", key: "max_sent", label: "Max enchaîné", scope: "item", field: "grade", fn: "max", filter: { field: "result", anyOf: ["flash", "sent"] } },
      { type: "share", key: "flash_rate", label: "Taux de flash", filter: { field: "result", anyOf: ["flash"] } },
    ],
    painZones: ["fingers_right", "fingers_left", "elbow_right", "elbow_left", "shoulder_right", "shoulder_left"],
    usesGear: false,
    gradeScaleBy: { field: "discipline", scales: { boulder: "fontainebleau", board: "fontainebleau", lead: "french", top_rope: "french" } },
  },
  yoga: {
    label: "Yoga",
    icon: "yoga",
    archetype: "continuous",
    sessionFields: [kind("Style", [{ key: "vinyasa", label: "Vinyasa" }, { key: "hatha", label: "Hatha" }, { key: "yin", label: "Yin" }, { key: "mobility", label: "Mobilité" }]), place],
    itemLabel: null,
    itemFields: [],
    indicators: [],
    painZones: ["lower_back", "hip_right", "hip_left", "wrist_right", "wrist_left"],
    usesGear: false,
    gradeScaleBy: null,
  },
} as const satisfies Record<string, SportDefinition>;

export type SportKey = keyof typeof sports;

export const catalogVersion = 1;

export function sessionValuesSchema(sport: SportDefinition): z.ZodType<FieldValues> {
  return valuesSchema(sport.sessionFields);
}

export function targetValuesSchema(sport: SportDefinition): z.ZodType<FieldValues> {
  return valuesSchema(sport.sessionFields.map((field) => ({ ...field, required: false })));
}

export function itemValuesSchema(sport: SportDefinition, sessionValues: FieldValues): z.ZodType<FieldValues> {
  const scaleBy = sport.gradeScaleBy;
  if (scaleBy === null) return valuesSchema(sport.itemFields);
  const option = sessionValues[scaleBy.field];
  const scale = typeof option === "string" ? scaleBy.scales[option] : undefined;
  if (scale === undefined) throw new Error(`No grade scale for ${scaleBy.field}=${JSON.stringify(option)}`);
  return valuesSchema(sport.itemFields.map((field) => (field.type === "grade" ? { ...field, scales: [scale] } : field)));
}
export const sportKeys = Object.keys(sports) as [SportKey, ...SportKey[]];
