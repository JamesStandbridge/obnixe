import { sports } from "@obnixe/schema";
import type { Author, Effort, Equipment, ExerciseMeasure, Id, MassUnit } from "@obnixe/schema";
import type { DraftIssue, DraftItem, DraftSlot, DraftVariant, ItemTarget, ProgramChange, ProgramDraft, PublishIssue, VersionAuthor } from "@obnixe/core";
import { formatClock } from "@/format/durations";
import { capitalize, lowerFirst, plural } from "@/format/labels";

export type ExerciseName = (id: Id) => string;

const weekdaysShort = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."] as const;
const months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"] as const;
const monthsShort = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."] as const;
const dayMs = 86_400_000;

export function formatDecimal(value: number, digits = 2): string {
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
  return String(rounded).replace(".", ",");
}

export function formatTargetDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${String(rest).padStart(2, "0")}`;
}

export const effortLabels: Readonly<Record<Effort, string>> = { easy: "Facile", moderate: "Modéré", hard: "Dur", very_hard: "Très dur", max: "Max" };

export const equipmentLabels: Readonly<Record<Equipment, string>> = {
  barbell: "Barre",
  dumbbell: "Haltères",
  kettlebell: "Kettlebell",
  machine: "Machine",
  cable: "Poulie",
  bodyweight: "Poids du corps",
  band: "Élastique",
  other: "Autre",
};

export const measureLabels: Readonly<Record<ExerciseMeasure, string>> = { load_reps: "Charge × reps", bodyweight_reps: "Reps", duration: "Durée" };

export function formatTargetRange(target: ItemTarget): string {
  switch (target.kind) {
    case "reps":
      return target.min === target.max ? `${target.min}` : `${target.min}–${target.max}`;
    case "duration": {
      const { minSeconds, maxSeconds } = target;
      if (maxSeconds < 60) return minSeconds === maxSeconds ? `${minSeconds} s` : `${minSeconds}–${maxSeconds} s`;
      if (minSeconds % 60 === 0 && maxSeconds % 60 === 0) {
        return minSeconds === maxSeconds ? `${minSeconds / 60} min` : `${minSeconds / 60}–${maxSeconds / 60} min`;
      }
      return minSeconds === maxSeconds ? formatClock(minSeconds) : `${formatClock(minSeconds)}–${formatClock(maxSeconds)}`;
    }
    default: {
      const unreachable: never = target;
      return unreachable;
    }
  }
}

export function formatPrescription(item: DraftItem): string {
  return `${item.sets} × ${formatTargetRange(item.target)}`;
}

export function formatItemDetail(item: DraftItem): string {
  const parts: string[] = [];
  if (item.restSeconds !== null) parts.push(`repos ${formatClock(item.restSeconds)}`);
  if (item.targetRir !== null) parts.push(`RIR ${item.targetRir}`);
  return parts.join(" · ");
}

export function slotTitle(slot: DraftSlot): string {
  const first = slot.variants[0];
  return first === undefined ? slot.name : `${slot.name} · ${first.name}`;
}

export function slotDetail(slot: DraftSlot): string {
  if (sports[slot.sport].archetype === "strength") {
    const count = slot.variants[0]?.items.length ?? 0;
    const exercises = plural(count, "exercice");
    return slot.variants.length > 1 ? `${exercises} · ${plural(slot.variants.length, "variante")}` : exercises;
  }
  const parts: string[] = [];
  if (slot.targetDurationSeconds !== null) parts.push(formatTargetDuration(slot.targetDurationSeconds));
  if (slot.targetEffort !== null) parts.push(lowerFirst(effortLabels[slot.targetEffort]));
  return parts.length === 0 ? "sans objectif" : parts.join(" · ");
}

function localDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / dayMs;
}

export function formatLastDone(ms: number, now: number): string {
  const days = localDay(now) - localDay(ms);
  const date = new Date(ms);
  if (days === 0) return "auj.";
  if (days > 0 && days < 7) return weekdaysShort[date.getDay()] ?? "";
  return `${date.getDate()} ${monthsShort[date.getMonth()] ?? ""}`;
}

export function formatDay(ms: number, now: number): string {
  const date = new Date(ms);
  const sameYear = new Date(now).getFullYear() === date.getFullYear();
  return `${date.getDate() === 1 ? "1er" : date.getDate()} ${months[date.getMonth()] ?? ""}${sameYear ? "" : ` ${date.getFullYear()}`}`;
}

export function formatRelative(ms: number, now: number): string {
  const elapsed = now - ms;
  if (elapsed < 60_000) return "à l'instant";
  if (elapsed < 3_600_000) return `il y a ${Math.floor(elapsed / 60_000)} min`;
  const days = localDay(now) - localDay(ms);
  if (days === 0) return "aujourd'hui";
  if (days === 1) return "hier";
  if (days < 7) return `il y a ${days} jours`;
  return formatDay(ms, now);
}

export function formatDateTime(ms: number, now: number): string {
  const date = new Date(ms);
  return `${formatDay(ms, now)}, ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function authorLabel(author: VersionAuthor): string {
  const kind: Author = author.author;
  switch (kind) {
    case "agent":
      return author.client ?? "Agent";
    case "user":
      return "Toi";
    case "import":
      return "Import";
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

export function byAuthor(author: VersionAuthor): string {
  return author.author === "user" ? "par toi" : `par ${authorLabel(author)}`;
}

export function changeCountLabel(count: number): string {
  return count === 0 ? "Aucune modification" : plural(count, "modification");
}

export function formatLoadStep(grams: number, unit: MassUnit): string {
  switch (unit) {
    case "kg":
      return `${formatDecimal(grams / 1000)} kg`;
    case "lb":
      return `${formatDecimal(grams / 453.59237, 1)} lb`;
    default: {
      const unreachable: never = unit;
      return unreachable;
    }
  }
}

function elided(preposition: "de", name: string): string {
  return /^[aeiouyhàâäéèêëîïôöùûü]/i.test(name) ? `d'${lowerFirst(name)}` : `${preposition} ${lowerFirst(name)}`;
}

function slotContext(slot: DraftSlot, variant: DraftVariant | null): string {
  const name = lowerFirst(slot.name);
  return variant !== null && slot.variants.length > 1 ? `${name}, ${lowerFirst(variant.name)}` : name;
}

function describeSlot(slot: DraftSlot): string {
  return `${slotTitle(slot)} · ${slotDetail(slot)}`;
}

function describeItem(item: DraftItem, name: ExerciseName): string {
  return `${name(item.exerciseId)} · ${formatPrescription(item)}`;
}

export interface DiffSide {
  readonly label: string;
  readonly text: string;
}

export interface DiffBlock {
  readonly before: DiffSide | null;
  readonly after: DiffSide | null;
}

export function describeChange(change: ProgramChange, name: ExerciseName): DiffBlock {
  switch (change.kind) {
    case "program_renamed":
      return { before: { label: "Avant · nom", text: change.before }, after: { label: "Après", text: change.after } };
    case "frequency_changed":
      return { before: { label: "Avant · fréquence", text: `${change.before} par semaine` }, after: { label: "Après", text: `${change.after} par semaine` } };
    case "slot_added":
      return { before: null, after: { label: "Ajouté à la rotation", text: describeSlot(change.slot) } };
    case "slot_removed":
      return { before: { label: "Retiré de la rotation", text: describeSlot(change.slot) }, after: null };
    case "slot_changed": {
      const describe = change.fields.includes("name") || change.fields.includes("sport") ? describeSlot : (slot: DraftSlot) => capitalize(slotDetail(slot));
      return { before: { label: `Avant · ${lowerFirst(change.before.name)}`, text: describe(change.before) }, after: { label: "Après", text: describe(change.after) } };
    }
    case "slots_reordered":
      return {
        before: { label: "Avant · ordre", text: change.before.map((slot) => slot.name).join(", ") },
        after: { label: "Après", text: change.after.map((slot) => slot.name).join(", ") },
      };
    case "variant_added":
      return { before: null, after: { label: `Variante ajoutée · ${lowerFirst(change.slot.name)}`, text: `${change.variant.name} · ${plural(change.variant.items.length, "exercice")}` } };
    case "variant_removed":
      return { before: { label: `Variante retirée · ${lowerFirst(change.slot.name)}`, text: `${change.variant.name} · ${plural(change.variant.items.length, "exercice")}` }, after: null };
    case "variant_renamed":
      return { before: { label: `Avant · ${lowerFirst(change.slot.name)}`, text: change.before.name }, after: { label: "Après", text: change.after.name } };
    case "variants_reordered":
      return { before: null, after: { label: lowerFirst(change.slot.name), text: "Ordre des variantes modifié" } };
    case "item_added":
      return { before: null, after: { label: `Ajouté · ${slotContext(change.slot, change.variant)}`, text: describeItem(change.item, name) } };
    case "item_removed":
      return { before: { label: `Retiré · ${slotContext(change.slot, change.variant)}`, text: describeItem(change.item, name) }, after: null };
    case "item_replaced":
    case "item_changed":
      return { before: { label: `Avant · ${slotContext(change.slot, change.variant)}`, text: describeItem(change.before, name) }, after: { label: "Après", text: describeItem(change.after, name) } };
    case "items_reordered":
      return { before: null, after: { label: slotContext(change.slot, change.variant), text: "Ordre des exercices modifié" } };
    default: {
      const unreachable: never = change;
      return unreachable;
    }
  }
}

function summarizeChange(change: ProgramChange, name: ExerciseName): string {
  switch (change.kind) {
    case "program_renamed":
      return `Renommé en ${change.after}`;
    case "frequency_changed":
      return `${plural(change.after, "séance")} par semaine`;
    case "slot_added":
      return `Ajout : ${change.slot.name}`;
    case "slot_removed":
      return `Retrait : ${change.slot.name}`;
    case "slot_changed": {
      const { before, after, fields } = change;
      if (fields.length === 1 && fields[0] === "target_duration" && before.targetDurationSeconds !== null && after.targetDurationSeconds !== null) {
        const from = formatTargetDuration(before.targetDurationSeconds);
        const to = formatTargetDuration(after.targetDurationSeconds);
        return `${after.name} de ${from.endsWith(" min") && to.endsWith(" min") ? from.slice(0, -4) : from} à ${to}`;
      }
      if (fields.length === 1 && fields[0] === "name") return `${before.name} renommée ${after.name}`;
      return `${after.name} : ${slotDetail(after)}`;
    }
    case "slots_reordered":
      return "Nouvel ordre des séances";
    case "variant_added":
      return `${change.slot.name} ${lowerFirst(change.variant.name)}`;
    case "variant_removed":
      return `Retrait : variante ${lowerFirst(change.variant.name)}`;
    case "variant_renamed":
      return `Variante renommée ${change.after.name}`;
    case "variants_reordered":
      return "Nouvel ordre des variantes";
    case "item_added":
      return `Ajout : ${lowerFirst(name(change.item.exerciseId))}`;
    case "item_removed":
      return `Retrait : ${lowerFirst(name(change.item.exerciseId))}`;
    case "item_replaced":
      return `${name(change.after.exerciseId)} au lieu ${elided("de", name(change.before.exerciseId))}`;
    case "item_changed":
      return change.fields.includes("exercise")
        ? `${name(change.after.exerciseId)} au lieu ${elided("de", name(change.before.exerciseId))}`
        : `${name(change.after.exerciseId)} : ${formatPrescription(change.after)}`;
    case "items_reordered":
      return "Nouvel ordre des exercices";
    default: {
      const unreachable: never = change;
      return unreachable;
    }
  }
}

export function summarizeChanges(changes: readonly ProgramChange[], name: ExerciseName): string | null {
  const [first] = changes;
  if (first === undefined) return null;
  const head = summarizeChange(first, name);
  const others = changes.length - 1;
  return others === 0 ? head : `${head} · ${plural(others, "autre modification", "autres modifications")}`;
}

function slotName(draft: ProgramDraft, lineageId: Id): string {
  return draft.slots.find((slot) => slot.lineageId === lineageId)?.name.trim() || "Séance sans nom";
}

function variantName(draft: ProgramDraft, slotId: Id, variantId: Id): string {
  return draft.slots.find((slot) => slot.lineageId === slotId)?.variants.find((variant) => variant.lineageId === variantId)?.name.trim() || "sans nom";
}

function itemExercise(draft: ProgramDraft, slotId: Id, variantId: Id, itemId: Id, name: ExerciseName): string {
  const item = draft.slots
    .find((slot) => slot.lineageId === slotId)
    ?.variants.find((variant) => variant.lineageId === variantId)
    ?.items.find((entry) => entry.lineageId === itemId);
  return item === undefined ? "Exercice" : name(item.exerciseId);
}

export function issueMessage(issue: PublishIssue | DraftIssue, draft: ProgramDraft, name: ExerciseName): string {
  switch (issue.kind) {
    case "no_changes":
      return "Aucune modification";
    case "program_name_missing":
      return "Donne un nom au programme";
    case "sessions_per_week_invalid":
      return "Entre 1 et 14 séances par semaine";
    case "no_slots":
      return "Ajoute au moins une séance à la rotation";
    case "duplicate_lineage":
      return "Structure du programme incohérente";
    case "slot_name_missing":
      return "Nomme chaque séance";
    case "variants_missing":
      return `${slotName(draft, issue.slot)} : ajoute une variante`;
    case "variants_not_allowed":
      return `${slotName(draft, issue.slot)} : pas de variante pour ce sport`;
    case "target_duration_invalid":
      return `${slotName(draft, issue.slot)} : durée cible invalide`;
    case "target_values_invalid":
      return `${slotName(draft, issue.slot)} : objectif invalide`;
    case "variant_name_missing":
      return `${slotName(draft, issue.slot)} : nomme chaque variante`;
    case "variant_name_duplicate":
      return `${slotName(draft, issue.slot)} : deux variantes « ${variantName(draft, issue.slot, issue.variant)} »`;
    case "variant_empty":
      return `${slotName(draft, issue.slot)} · ${variantName(draft, issue.slot, issue.variant)} : ajoute un exercice`;
    case "item_invalid": {
      const exercise = itemExercise(draft, issue.slot, issue.variant, issue.item, name);
      switch (issue.problem) {
        case "exercise_missing":
          return `${slotName(draft, issue.slot)} : exercice introuvable`;
        case "exercise_unavailable":
          return `${exercise} est archivé, remplace-le`;
        case "target_mismatch":
          return `${exercise} : cible incompatible avec sa mesure`;
        case "sets_invalid":
          return `${exercise} : nombre de séries invalide`;
        case "range_invalid":
          return `${exercise} : fourchette invalide`;
        case "rir_invalid":
          return `${exercise} : RIR entre 0 et 5`;
        case "rest_invalid":
          return `${exercise} : repos invalide`;
        default: {
          const unreachable: never = issue.problem;
          return unreachable;
        }
      }
    }
    default: {
      const unreachable: never = issue;
      return unreachable;
    }
  }
}
