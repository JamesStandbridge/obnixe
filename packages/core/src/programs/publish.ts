import type { Id, ProgramStatus, ProgramVersion } from "@obnixe/schema";
import type { Mutation, NewRow } from "../writer.ts";
import { diffDrafts } from "./diff.ts";
import type { ProgramChange } from "./diff.ts";
import type { DraftItem, ProgramDraft } from "./draft.ts";
import { validateDraft } from "./validate.ts";
import type { DraftIssue, ExerciseRef } from "./validate.ts";

export interface PublishedBase {
  readonly version: ProgramVersion;
  readonly draft: ProgramDraft;
}

export interface PublishRequest {
  readonly programId: Id;
  readonly base: PublishedBase;
  readonly draft: ProgramDraft;
  readonly summary: string | null;
  readonly reason: string | null;
  readonly exercises: ReadonlyMap<Id, ExerciseRef>;
}

export interface CreateProgramRequest {
  readonly draft: ProgramDraft;
  readonly status: Exclude<ProgramStatus, "archived">;
  readonly copiedFromId: Id | null;
  readonly summary: string | null;
  readonly reason: string | null;
  readonly exercises: ReadonlyMap<Id, ExerciseRef>;
}

export interface PublishPlan {
  readonly programId: Id;
  readonly versionId: Id;
  readonly number: number;
  readonly changes: readonly ProgramChange[];
  readonly mutations: readonly Mutation[];
}

export type PublishIssue = DraftIssue | { readonly kind: "no_changes" };

export type PublishResult = { readonly ok: true; readonly plan: PublishPlan } | { readonly ok: false; readonly issues: readonly [PublishIssue, ...PublishIssue[]] };

interface VersionHeader {
  readonly programId: Id;
  readonly number: number;
  readonly copiedFromId: Id | null;
  readonly summary: string | null;
  readonly reason: string | null;
}

const cleanText = (value: string | null): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

interface VersionMutations {
  readonly versionId: Id;
  readonly mutations: Mutation[];
}

type ItemColumns = Omit<NewRow<"program_item">, "id" | "variantId" | "position">;

function versionMutations(header: VersionHeader, draft: ProgramDraft, newId: () => Id): VersionMutations {
  const versionId = newId();
  const mutations: Mutation[] = [
    {
      kind: "insert",
      table: "program_version",
      row: {
        id: versionId,
        programId: header.programId,
        number: header.number,
        name: draft.name.trim(),
        sessionsPerWeek: draft.sessionsPerWeek,
        copiedFromId: header.copiedFromId,
        summary: cleanText(header.summary),
        reason: cleanText(header.reason),
      },
    },
  ];
  draft.slots.forEach((slot, slotPosition) => {
    const slotId = newId();
    mutations.push({
      kind: "insert",
      table: "program_slot",
      row: {
        id: slotId,
        versionId,
        lineageId: slot.lineageId,
        position: slotPosition,
        sport: slot.sport,
        name: slot.name.trim(),
        targetDurationSeconds: slot.targetDurationSeconds,
        targetEffort: slot.targetEffort,
        targetValues: slot.targetValues,
      },
    });
    slot.variants.forEach((variant, variantPosition) => {
      const variantId = newId();
      mutations.push({ kind: "insert", table: "program_variant", row: { id: variantId, slotId, lineageId: variant.lineageId, position: variantPosition, name: variant.name.trim() } });
      variant.items.forEach((item, itemPosition) => {
        mutations.push({ kind: "insert", table: "program_item", row: { id: newId(), variantId, position: itemPosition, ...itemColumns(item) } });
      });
    });
  });
  return { versionId, mutations };
}

function itemColumns(item: DraftItem): ItemColumns {
  const common = {
    lineageId: item.lineageId,
    exerciseId: item.exerciseId,
    sets: item.sets,
    targetRir: item.targetRir,
    restSeconds: item.restSeconds,
    restAfterSeconds: item.restAfterSeconds,
  };
  const target = item.target;
  switch (target.kind) {
    case "reps":
      return { ...common, repsMin: target.min, repsMax: target.max, durationMinSeconds: null, durationMaxSeconds: null };
    case "duration":
      return { ...common, repsMin: null, repsMax: null, durationMinSeconds: target.minSeconds, durationMaxSeconds: target.maxSeconds };
    default: {
      const unreachable: never = target;
      throw new Error(`Unhandled item target ${JSON.stringify(unreachable)}`);
    }
  }
}

export function planPublish(request: PublishRequest, newId: () => Id): PublishResult {
  const validation = validateDraft(request.draft, request.exercises);
  if (!validation.valid) return { ok: false, issues: validation.issues };
  const changes = diffDrafts(request.base.draft, request.draft);
  if (changes.length === 0) return { ok: false, issues: [{ kind: "no_changes" }] };
  const number = request.base.version.number + 1;
  const { versionId, mutations } = versionMutations(
    { programId: request.programId, number, copiedFromId: request.base.version.id, summary: request.summary, reason: request.reason },
    request.draft,
    newId,
  );
  return { ok: true, plan: { programId: request.programId, versionId, number, changes, mutations } };
}

export function planCreateProgram(request: CreateProgramRequest, newId: () => Id): PublishResult {
  const validation = validateDraft(request.draft, request.exercises);
  if (!validation.valid) return { ok: false, issues: validation.issues };
  const programId = newId();
  const { versionId, mutations } = versionMutations(
    { programId, number: 1, copiedFromId: request.copiedFromId, summary: request.summary, reason: request.reason },
    request.draft,
    newId,
  );
  return {
    ok: true,
    plan: { programId, versionId, number: 1, changes: [], mutations: [{ kind: "insert", table: "program", row: { id: programId, status: request.status } }, ...mutations] },
  };
}
