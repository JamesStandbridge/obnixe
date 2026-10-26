import { activeSeconds, completedSets, gramsToMass, parseGrade } from "@obnixe/core";
import type { ClimbBreakdown, ExerciseOutcome, ExerciseReport, SessionReport, StrengthSummary } from "@obnixe/core";
import { sports } from "@obnixe/schema";
import type { Dimension, EpochMs, FieldDefinition, FieldValue, FieldValues, IndicatorDefinition, LocalDate, MassUnit, Session, SessionItem, SportKey } from "@obnixe/schema";
import { formatClock, formatDuration, formatLongClock, formatMass, formatNumber, formatSigned, formatTime, plural, relativeDay } from "@/features/training/format";

export function choiceLabel(field: FieldDefinition, key: string): string {
  if (field.type !== "choice") return key;
  return field.options.find((option) => option.key === key)?.label ?? key;
}

function fieldOf(sport: SportKey, key: string): FieldDefinition | undefined {
  return sports[sport].sessionFields.find((field) => field.key === key);
}

export function sessionTitle(report: Pick<SessionReport, "data">): string {
  const { session, slot, variant } = report.data;
  if (session.title !== null) return session.title;
  if (slot !== null && session.sport === "strength") return variant === null ? slot.name : `${slot.name} · ${variant.name}`;
  const sport = sports[session.sport];
  if (session.sport === "climb") {
    const discipline = session.values.discipline;
    const disciplineField = fieldOf("climb", "discipline");
    const label = typeof discipline === "string" && disciplineField !== undefined ? choiceLabel(disciplineField, discipline) : sport.label;
    return typeof session.values.place === "string" ? `${label} · ${session.values.place}` : label;
  }
  const kind = session.values.kind;
  const kindField = fieldOf(session.sport, "kind");
  if (typeof kind === "string" && kindField !== undefined) return choiceLabel(kindField, kind);
  return slot?.name ?? sport.label;
}

export function shortTitle(report: Pick<SessionReport, "data">): string {
  const { session, slot } = report.data;
  if (session.sport === "strength") return slot?.name ?? sports.strength.label;
  return sports[session.sport].label;
}

export function quantityText(key: string, value: number, dimension: Dimension, unit: MassUnit): string {
  switch (dimension) {
    case "distance":
      if (key === "elevation_gain" || key === "pool_length" || value < 1000) return `${formatNumber(value, 0)} m`;
      return `${formatNumber(value / 1000, value < 10_000 ? 2 : 1)} km`;
    case "mass":
      return `${formatMass(value, unit)} ${unit}`;
    case "length":
      return `${formatNumber(value / 10)} cm`;
    case "duration":
      return formatLongClock(value);
    case "count":
      return formatNumber(value, 0);
    case "heart_rate":
      return `${value} bpm`;
    case "power":
      return `${value} W`;
    default: {
      const unreachable: never = dimension;
      return unreachable;
    }
  }
}

export interface FigureText {
  readonly text: string;
  readonly unit: string;
}

export function distanceFigure(meters: number): FigureText {
  return meters < 1000 ? { text: formatNumber(meters, 0), unit: "m" } : { text: formatNumber(meters / 1000, meters < 10_000 ? 2 : 1), unit: "km" };
}

export function fieldValueText(field: FieldDefinition, value: FieldValue | undefined, unit: MassUnit): string | null {
  if (value === undefined) return null;
  switch (field.type) {
    case "quantity":
      return typeof value === "number" ? quantityText(field.key, value, field.dimension, unit) : null;
    case "grade":
      return parseGrade(value)?.label ?? null;
    case "choice":
      if (Array.isArray(value)) return value.length === 0 ? null : value.map((key) => choiceLabel(field, key)).join(", ");
      return typeof value === "string" ? choiceLabel(field, value) : null;
    case "text":
      return typeof value === "string" ? value : null;
    case "toggle":
      return value === true ? "Oui" : "Non";
    default: {
      const unreachable: never = field;
      return unreachable;
    }
  }
}

function operand(name: string, values: FieldValues, durationSeconds: number): number | null {
  if (name === "duration") return durationSeconds;
  const value = values[name];
  return typeof value === "number" ? value : null;
}

export function indicatorText(indicator: IndicatorDefinition, values: FieldValues, durationSeconds: number): string | null {
  if (indicator.type !== "ratio") return null;
  const numerator = operand(indicator.numerator, values, durationSeconds);
  const denominator = operand(indicator.denominator, values, durationSeconds);
  if (numerator === null || denominator === null || numerator <= 0 || denominator <= 0) return null;
  const ratio = (numerator / denominator) * indicator.per;
  if (indicator.numerator === "duration") return `${formatClock(ratio)} /${indicator.per === 1000 ? "km" : `${indicator.per} m`}`;
  return `${formatNumber(ratio / 1000)} km/h`;
}

export function continuousIndicators(session: Session, now: EpochMs): readonly string[] {
  const duration = activeSeconds(session, now);
  return sports[session.sport].indicators.flatMap((indicator) => {
    const text = indicatorText(indicator, session.values, duration);
    return text === null ? [] : [text];
  });
}

export function climbFacts(climb: ClimbBreakdown, itemWord: { readonly singular: string; readonly plural: string }): readonly string[] {
  const facts = [plural(climb.count, itemWord.singular, itemWord.plural)];
  if (climb.maxSent !== null) facts.push(`max enchaîné ${climb.maxSent}`);
  if (climb.flash > 0) facts.push(`${climb.flash} flash`);
  return facts;
}

export function climbItemWord(session: Session): { readonly singular: string; readonly plural: string } {
  const discipline = session.values.discipline;
  return discipline === "lead" || discipline === "top_rope" ? { singular: "voie", plural: "voies" } : { singular: "bloc", plural: "blocs" };
}

export function climbItemText(item: SessionItem): { readonly grade: string; readonly style: string; readonly result: string } {
  const field = sports.climb.itemFields.find((candidate) => candidate.key === "style");
  const style = field === undefined ? null : fieldValueText(field, item.values.style, "kg")?.toLowerCase();
  const attempts = typeof item.values.attempts === "number" ? item.values.attempts : 1;
  const result = item.values.result;
  const resultText = result === "flash" ? "flash" : result === "sent" ? (attempts > 1 ? `${attempts} essais` : "enchaîné") : `pas encore · ${attempts}`;
  return { grade: parseGrade(item.values.grade)?.label ?? "–", style: style ?? "", result: resultText };
}

export function strengthValue(report: ExerciseReport, unit: MassUnit): { readonly value: string; readonly detail: string } {
  const sets = completedSets(report.exercise.sets);
  if (sets.length === 0) return { value: "–", detail: "" };
  const measure = report.exercise.exercise.measure;
  if (measure === "duration") return { value: plural(sets.length, "série", "séries"), detail: sets.map((set) => formatClock(set.durationSeconds ?? 0)).join(" · ") };
  const top = Math.max(...sets.map((set) => set.loadGrams ?? 0));
  const reps = sets.map((set) => String(set.reps ?? 0)).join(" · ");
  if (measure === "bodyweight_reps" && top === 0) return { value: plural(sets.length, "série", "séries"), detail: reps };
  return { value: `${sets.length} × ${formatMass(top, unit)}`, detail: reps };
}

export function outcomeText(outcome: ExerciseOutcome, today: LocalDate, unit: MassUnit, withDate: boolean): string {
  switch (outcome.kind) {
    case "skipped":
      return "passé";
    case "stopped":
      return `arrêté à la série ${outcome.setsDone + 1}`;
    case "suspended":
      return "suspendue";
    case "first":
      return "première fois";
    case "load": {
      const delta = Math.round((gramsToMass(Math.abs(outcome.deltaGrams), unit) * Math.sign(outcome.deltaGrams)) * 10) / 10;
      return `${formatSigned(delta)} ${unit}${withDate ? ` vs ${relativeDay(outcome.previousDate, today)}` : ""}`;
    }
    case "reps":
      return `${formatSigned(outcome.delta, 0)} rép.`;
    case "duration":
      return `${formatSigned(outcome.deltaSeconds, 0)} s`;
    case "same":
      return `comme ${relativeDay(outcome.previousDate, today)}`;
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

export function timeRange(session: Session): string {
  const start = formatTime(session.startedAt, session.timeZone);
  return session.endedAt === null ? start : `${start} – ${formatTime(session.endedAt, session.timeZone)}`;
}

export function durationText(session: Session, now: EpochMs): string {
  return formatDuration(activeSeconds(session, now));
}
export function setsFact(summary: StrengthSummary): string {
  return `${plural(summary.setsDone, "série", "séries")} sur ${summary.setsPlanned}`;
}
