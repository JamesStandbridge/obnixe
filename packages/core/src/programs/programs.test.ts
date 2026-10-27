import { beforeEach, describe, expect, it } from "vitest";
import { exercise as exerciseTable, program } from "@obnixe/schema";
import type { Exercise, Id, LocalDate, ZoneKey } from "@obnixe/schema";
import { nextSlot } from "../rotation.ts";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { revert } from "../undo.ts";
import { commit } from "../writer.ts";
import type { Mutation } from "../writer.ts";
import { diffDrafts } from "./diff.ts";
import type { ProgramChange } from "./diff.ts";
import { draftFromTree, emptyDraft, withFreshLineages } from "./draft.ts";
import type { DraftItem, DraftSlot, ProgramDraft } from "./draft.ts";
import { moveByLineage, removeByLineage, updateItems, updateSlot } from "./edit.ts";
import { findExerciseByName, normalizeCues, planArchiveExercise, planCreateExercise, planExerciseCues, planUpdateExercise, searchExercises } from "./exercises.ts";
import type { ExerciseInput } from "./exercises.ts";
import { planCreateProgram, planPublish } from "./publish.ts";
import type { PublishIssue, PublishPlan, PublishResult } from "./publish.ts";
import { exerciseRefs, exerciseUsage, latestVersion, lastSessionBySlotLineage, listPrograms, listVersions, loadVersionTree } from "./queries.ts";
import { planActivate, planArchive } from "./status.ts";
import { validateDraft } from "./validate.ts";

let context: TestContext;

beforeEach(() => {
  context = createTestContext();
});

const newId = (): Id => context.env.newId();

function write(mutations: readonly Mutation[], summary = "Test"): Id {
  return commit(context.db, context.env, { actor: { author: "user", connectionId: null }, summary, revertsId: null, mutations });
}

function exercises(): Exercise[] {
  return context.db.select().from(exerciseTable).all();
}

function createExercise(name: string, measure: ExerciseInput["measure"] = "load_reps", zones: readonly ZoneKey[] = []): Id {
  const plan = planCreateExercise({ name, measure, equipment: measure === "load_reps" ? "barbell" : "bodyweight", loadMode: "total", baseGrams: null, loadStepGrams: measure === "load_reps" ? 2500 : null, zones }, exercises(), newId);
  if (!plan.ok) throw new Error(`Exercise ${name} refused: ${plan.issue.kind}`);
  write(plan.mutations);
  return plan.exerciseId;
}

function item(exerciseId: Id, min = 8, max = 12): DraftItem {
  return { lineageId: newId(), exerciseId, sets: 3, target: { kind: "reps", min, max }, targetRir: 2, restSeconds: 120, restAfterSeconds: null };
}

function strengthSlot(name: string, items: readonly DraftItem[]): DraftSlot {
  return { lineageId: newId(), sport: "strength", name, targetDurationSeconds: null, targetEffort: null, targetValues: {}, variants: [{ lineageId: newId(), name: "Salle", items }] };
}

function runSlot(): DraftSlot {
  return { lineageId: newId(), sport: "run", name: "Course · footing", targetDurationSeconds: 2100, targetEffort: "easy", targetValues: { kind: "easy" }, variants: [] };
}

function planned(result: PublishResult): PublishPlan {
  if (!result.ok) throw new Error(`Publish refused: ${result.issues.map((issue) => issue.kind).join(", ")}`);
  return result.plan;
}

interface Fixture {
  readonly programId: Id;
  readonly draft: ProgramDraft;
  readonly squat: Id;
  readonly bench: Id;
  readonly row: Id;
}

function createProgram(status: "draft" | "active" = "active"): Fixture {
  const squat = createExercise("Squat barre");
  const bench = createExercise("Développé couché", "load_reps", ["shoulder_right"]);
  const row = createExercise("Rowing haltère");
  const draft: ProgramDraft = {
    name: "Base hiver",
    sessionsPerWeek: 4,
    slots: [strengthSlot("Séance A", [item(squat), item(bench)]), strengthSlot("Séance B", [item(row)]), runSlot()],
  };
  const plan = planned(planCreateProgram({ draft, status, copiedFromId: null, summary: null, reason: null, exercises: exerciseRefs(exercises()) }, newId));
  write(plan.mutations);
  return { programId: plan.programId, draft, squat, bench, row };
}

function publishedDraft(programId: Id): { readonly versionId: Id; readonly draft: ProgramDraft } {
  const version = latestVersion(context.db, programId);
  if (version === null) throw new Error("No version");
  const tree = loadVersionTree(context.db, version.id);
  if (tree === null) throw new Error("No tree");
  return { versionId: version.id, draft: draftFromTree(tree) };
}

function publish(programId: Id, draft: ProgramDraft): PublishResult {
  const version = latestVersion(context.db, programId);
  if (version === null) throw new Error("No version");
  const tree = loadVersionTree(context.db, version.id);
  if (tree === null) throw new Error("No tree");
  return planPublish({ programId, base: { version, draft: draftFromTree(tree) }, draft, summary: "Modif", reason: null, exercises: exerciseRefs(exercises()) }, newId);
}

function at(slots: readonly DraftSlot[], index: number): DraftSlot {
  const slot = slots[index];
  if (slot === undefined) throw new Error(`No slot ${index}`);
  return slot;
}

function firstVariantItems(slot: DraftSlot): readonly DraftItem[] {
  return slot.variants[0]?.items ?? [];
}

function kinds(changes: readonly ProgramChange[]): string[] {
  return changes.map((change) => change.kind).sort();
}

function issueKinds(issues: readonly PublishIssue[]): string[] {
  return issues.map((issue) => (issue.kind === "item_invalid" ? `item_invalid:${issue.problem}` : issue.kind)).sort();
}

describe("planCreateProgram", () => {
  it("publishes v1 with its full tree and round-trips the draft", () => {
    const fixture = createProgram();
    const stored = context.db.select().from(program).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("active");
    const { draft } = publishedDraft(fixture.programId);
    expect(draft).toEqual(fixture.draft);
    const version = latestVersion(context.db, fixture.programId);
    expect(version?.number).toBe(1);
    expect(version?.copiedFromId).toBeNull();
    expect(nextSlot(context.db)?.slot.lineageId).toBe(at(fixture.draft.slots, 0).lineageId);
  });

  it("refuses an invalid draft with typed issues", () => {
    const archived = createExercise("Tirage menton");
    const archive = planArchiveExercise(exercises().find((row) => row.id === archived) as Exercise, context.env.now());
    if (archive === null) throw new Error("Not archivable");
    write([archive]);
    const timed = createExercise("Gainage", "duration");
    const draft: ProgramDraft = {
      name: "  ",
      sessionsPerWeek: 0,
      slots: [
        { ...strengthSlot("Séance A", []), variants: [] },
        strengthSlot("Séance B", []),
        strengthSlot("Séance C", [item(archived), item(timed), { ...item(timed), target: { kind: "duration", minSeconds: 45, maxSeconds: 30 } }]),
        { ...runSlot(), targetValues: { kind: "sprint" } },
      ],
    };
    const result = planCreateProgram({ draft, status: "draft", copiedFromId: null, summary: null, reason: null, exercises: exerciseRefs(exercises()) }, newId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(issueKinds(result.issues)).toEqual([
      "item_invalid:exercise_unavailable",
      "item_invalid:range_invalid",
      "item_invalid:target_mismatch",
      "program_name_missing",
      "sessions_per_week_invalid",
      "target_values_invalid",
      "variant_empty",
      "variants_missing",
    ]);
    expect(validateDraft(emptyDraft(), new Map()).valid).toBe(false);
  });
});

describe("planPublish", () => {
  it("publishes v2 keeping lineages of kept and edited elements and minting new ones", () => {
    const fixture = createProgram();
    const before = publishedDraft(fixture.programId);
    const [slotA, slotB, run] = [at(before.draft.slots, 0), at(before.draft.slots, 1), at(before.draft.slots, 2)];
    const added = item(fixture.squat, 5, 5);
    let draft = updateItems(before.draft, slotB.lineageId, slotB.variants[0]?.lineageId as Id, (items) => [...items, added]);
    draft = updateSlot(draft, run.lineageId, (slot) => ({ ...slot, targetDurationSeconds: 2400 }));
    draft = updateItems(draft, slotA.lineageId, slotA.variants[0]?.lineageId as Id, (items) => items.map((entry) => ({ ...entry, sets: 4 })));
    const plan = planned(publish(fixture.programId, draft));
    expect(plan.number).toBe(2);
    write(plan.mutations);
    const after = publishedDraft(fixture.programId);
    expect(after.versionId).toBe(plan.versionId);
    expect(latestVersion(context.db, fixture.programId)?.copiedFromId).toBe(before.versionId);
    expect(after.draft.slots.map((slot) => slot.lineageId)).toEqual(before.draft.slots.map((slot) => slot.lineageId));
    expect(firstVariantItems(at(after.draft.slots, 0)).map((entry) => entry.lineageId)).toEqual(firstVariantItems(slotA).map((entry) => entry.lineageId));
    expect(firstVariantItems(at(after.draft.slots, 1)).map((entry) => entry.lineageId)).toEqual([...firstVariantItems(slotB).map((entry) => entry.lineageId), added.lineageId]);
    expect(after.draft).toEqual(draft);
    const rows = loadVersionTree(context.db, plan.versionId);
    const oldRows = loadVersionTree(context.db, before.versionId);
    expect(rows?.slots[0]?.slot.id).not.toBe(oldRows?.slots[0]?.slot.id);
    expect(oldRows?.slots[0]?.variants[0]?.items[0]?.sets).toBe(3);
  });

  it("refuses to publish without changes", () => {
    const fixture = createProgram();
    const result = publish(fixture.programId, publishedDraft(fixture.programId).draft);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].kind).toBe("no_changes");
  });

  it("keeps the rotation position across versions and reverts a version into a new one", () => {
    const fixture = createProgram();
    const v1 = publishedDraft(fixture.programId);
    const slotA = at(v1.draft.slots, 0);
    const tree = loadVersionTree(context.db, v1.versionId);
    const startedAt = context.env.now();
    write([
      {
        kind: "insert",
        table: "session",
        row: {
          id: newId(),
          sport: "strength",
          slotId: tree?.slots[0]?.slot.id as Id,
          variantId: null,
          countsInRotation: true,
          gearId: null,
          title: null,
          status: "completed",
          startedAt,
          endedAt: startedAt,
          pausedSeconds: 0,
          localDate: "2026-10-24" as LocalDate,
          timeZone: "Europe/Paris",
          values: {},
          effort: null,
          sensation: null,
          enjoyment: null,
          note: null,
          review: "skipped",
          deletedAt: null,
        },
      },
    ]);
    expect(lastSessionBySlotLineage(context.db, fixture.programId).get(slotA.lineageId)).toBe(startedAt);
    context.advance(60_000);
    const plan = planned(publish(fixture.programId, { ...v1.draft, slots: moveByLineage(v1.draft.slots, at(v1.draft.slots, 2).lineageId, -1) }));
    const changesetId = write(plan.mutations);
    expect(nextSlot(context.db)?.slot.lineageId).toBe(at(v1.draft.slots, 2).lineageId);
    const versions = listVersions(context.db, fixture.programId);
    expect(versions.map((entry) => [entry.version.number, entry.latest, entry.revertible])).toEqual([
      [2, true, true],
      [1, false, false],
    ]);
    revert(context.db, context.env, { actor: { author: "user", connectionId: null }, changesetId, summary: "Annulation", restoredVersionSummary: (number) => `Retour à la v${number}` });
    const restored = publishedDraft(fixture.programId);
    expect(latestVersion(context.db, fixture.programId)?.number).toBe(3);
    expect(restored.draft).toEqual(v1.draft);
    expect(listVersions(context.db, fixture.programId)[1]?.revertible).toBe(false);
  });
});

describe("diffDrafts", () => {
  it("reports changes by lineage", () => {
    const fixture = createProgram();
    const before = publishedDraft(fixture.programId).draft;
    const slotA = at(before.slots, 0);
    const slotB = at(before.slots, 1);
    const variantA = slotA.variants[0]?.lineageId as Id;
    const variantB = slotB.variants[0]?.lineageId as Id;
    const replacement = item(fixture.squat, 6, 8);
    let after: ProgramDraft = { ...before, name: "Base printemps", sessionsPerWeek: 5 };
    after = updateItems(after, slotB.lineageId, variantB, () => [replacement]);
    after = updateItems(after, slotA.lineageId, variantA, (items) => moveByLineage(items, items[1]?.lineageId as Id, -1).map((entry, index) => (index === 0 ? { ...entry, targetRir: 1 } : entry)));
    after = updateSlot(after, slotB.lineageId, (slot) => ({ ...slot, variants: [...slot.variants, { lineageId: newId(), name: "Sans matériel", items: [item(fixture.row)] }] }));
    after = { ...after, slots: [...removeByLineage(after.slots, at(before.slots, 2).lineageId), runSlot()] };
    const changes = diffDrafts(before, after);
    expect(kinds(changes)).toEqual(["frequency_changed", "item_changed", "item_replaced", "items_reordered", "program_renamed", "slot_added", "slot_removed", "variant_added"]);
    const replaced = changes.find((change) => change.kind === "item_replaced");
    expect(replaced?.kind === "item_replaced" && replaced.before.exerciseId).toBe(fixture.row);
    const changed = changes.find((change) => change.kind === "item_changed");
    expect(changed?.kind === "item_changed" && changed.fields).toEqual(["rir"]);
    expect(diffDrafts(before, before)).toEqual([]);
  });

  it("reports pure removals and edits of a kept slot", () => {
    const fixture = createProgram();
    const before = publishedDraft(fixture.programId).draft;
    const slotA = at(before.slots, 0);
    const run = at(before.slots, 2);
    let after = updateItems(before, slotA.lineageId, slotA.variants[0]?.lineageId as Id, (items) => items.slice(0, 1));
    after = updateSlot(after, run.lineageId, (slot) => ({ ...slot, targetDurationSeconds: 2400, targetValues: { kind: "long" } }));
    const changes = diffDrafts(before, after);
    expect(kinds(changes)).toEqual(["item_removed", "slot_changed"]);
    const slotChange = changes.find((change) => change.kind === "slot_changed");
    expect(slotChange?.kind === "slot_changed" && slotChange.fields).toEqual(["target_duration", "target_values"]);
  });

  it("gives copies fresh lineages", () => {
    const fixture = createProgram();
    const draft = publishedDraft(fixture.programId).draft;
    const copy = withFreshLineages(draft, newId);
    expect(copy.slots.map((slot) => slot.lineageId)).not.toEqual(draft.slots.map((slot) => slot.lineageId));
    expect(kinds(diffDrafts(draft, copy))).toEqual(["slot_added", "slot_added", "slot_added", "slot_removed", "slot_removed", "slot_removed"]);
  });
});

describe("program status", () => {
  it("keeps a single active program", () => {
    const first = createProgram("active");
    const second = planned(planCreateProgram({ draft: withFreshLineages(first.draft, newId), status: "draft", copiedFromId: null, summary: null, reason: null, exercises: exerciseRefs(exercises()) }, newId));
    write(second.mutations);
    expect(() => write([{ kind: "update", table: "program", key: second.programId, patch: { status: "active" } }])).toThrow();
    const activation = planActivate(context.db.select().from(program).all(), second.programId);
    expect(activation.ok).toBe(true);
    if (!activation.ok) return;
    expect(activation.archived?.id).toBe(first.programId);
    write(activation.mutations);
    const statuses = Object.fromEntries(context.db.select().from(program).all().map((row) => [row.id, row.status]));
    expect(statuses).toEqual({ [first.programId]: "archived", [second.programId]: "active" });
    expect(planActivate(context.db.select().from(program).all(), second.programId)).toEqual({ ok: false, refusal: "already_active" });
    const active = context.db.select().from(program).all().find((row) => row.id === second.programId);
    if (active === undefined) throw new Error("Missing program");
    const archive = planArchive(active);
    if (!archive.ok) throw new Error("Not archivable");
    write(archive.mutations);
    expect(nextSlot(context.db)).toBeNull();
    expect(listPrograms(context.db).map((entry) => entry.program.status)).toEqual(["archived", "archived"]);
  });
});

describe("exercises", () => {
  it("rejects duplicate names by key and offers the existing exercise", () => {
    const id = createExercise("Développé couché");
    const duplicate = planCreateExercise({ name: "  developpe   COUCHÉ ", measure: "load_reps", equipment: "barbell", loadMode: "total", baseGrams: null, loadStepGrams: 2500, zones: [] }, exercises(), newId);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.issue.kind === "name_taken" && duplicate.issue.existing.id).toBe(id);
    const archive = planArchiveExercise(exercises()[0] as Exercise, context.env.now());
    if (archive === null) throw new Error("Not archivable");
    write([archive]);
    expect(findExerciseByName(exercises(), "Developpe couche")?.id).toBe(id);
    expect(searchExercises(exercises(), "dev")).toEqual([]);
    expect(planCreateExercise({ name: "Gainage", measure: "duration", equipment: "bodyweight", loadMode: "total", baseGrams: null, loadStepGrams: 1000, zones: [] }, exercises(), newId)).toEqual({
      ok: false,
      issue: { kind: "load_step_invalid" },
    });
    expect(planCreateExercise({ name: " ", measure: "duration", equipment: "bodyweight", loadMode: "total", baseGrams: null, loadStepGrams: null, zones: [] }, exercises(), newId)).toEqual({
      ok: false,
      issue: { kind: "name_missing" },
    });
  });

  it("stores the load mode and refuses a base weight outside per side loads", () => {
    const base = { measure: "load_reps", equipment: "barbell", loadStepGrams: 1250, zones: [] } as const;
    expect(planCreateExercise({ ...base, name: "Curl barre EZ", loadMode: "total", baseGrams: 10_000 }, exercises(), newId)).toEqual({ ok: false, issue: { kind: "load_mode_invalid" } });
    expect(planCreateExercise({ ...base, name: "Gainage", measure: "duration", equipment: "bodyweight", loadStepGrams: null, loadMode: "per_hand", baseGrams: null }, exercises(), newId)).toEqual({
      ok: false,
      issue: { kind: "load_mode_invalid" },
    });
    const created = planCreateExercise({ ...base, name: "Curl barre EZ", loadMode: "per_side", baseGrams: 10_000 }, exercises(), newId);
    if (!created.ok) throw new Error(created.issue.kind);
    write(created.mutations);
    const curl = exercises().find((row) => row.id === created.exerciseId) as Exercise;
    expect(curl).toMatchObject({ loadMode: "per_side", baseGrams: 10_000 });
    const update = planUpdateExercise({ exercise: curl, zones: [], inUse: true, input: { ...base, name: "Curl barre EZ", loadMode: "per_hand", baseGrams: null } }, exercises());
    if (!update.ok) throw new Error(update.issue.kind);
    expect(update.mutations).toEqual([expect.objectContaining({ kind: "update", patch: expect.objectContaining({ loadMode: "per_hand", baseGrams: null }) })]);
  });

  it("searches, edits zones and locks the measure once used", () => {
    const fixture = createProgram();
    expect(searchExercises(exercises(), "row").map((row) => row.name)).toEqual(["Rowing haltère"]);
    expect(searchExercises(exercises(), "").map((row) => row.name)).toEqual(["Développé couché", "Rowing haltère", "Squat barre"]);
    expect(searchExercises(exercises(), "barre squat").map((row) => row.name)).toEqual(["Squat barre"]);
    const bench = exercises().find((row) => row.id === fixture.bench) as Exercise;
    const usage = exerciseUsage(context.db, bench.id);
    expect(usage).toEqual({ inUse: true, programNames: ["Base hiver"] });
    const locked = planUpdateExercise({ exercise: bench, zones: ["shoulder_right"], inUse: usage.inUse, input: { name: "Développé couché", measure: "bodyweight_reps", equipment: "barbell", loadMode: "total", baseGrams: null, loadStepGrams: null, zones: [] } }, exercises());
    expect(locked).toEqual({ ok: false, issue: { kind: "measure_locked" } });
    const taken = planUpdateExercise({ exercise: bench, zones: ["shoulder_right"], inUse: true, input: { name: "squat BARRE", measure: "load_reps", equipment: "barbell", loadMode: "total", baseGrams: null, loadStepGrams: 2500, zones: [] } }, exercises());
    expect(taken.ok).toBe(false);
    const update = planUpdateExercise(
      { exercise: bench, zones: ["shoulder_right"], inUse: true, input: { name: "Développé couché barre", measure: "load_reps", equipment: "barbell", loadMode: "total", baseGrams: null, loadStepGrams: 1250, zones: ["shoulder_left", "elbow_right"] } },
      exercises(),
    );
    if (!update.ok) throw new Error(update.issue.kind);
    expect(update.mutations.map((mutation) => mutation.kind)).toEqual(["update", "delete", "insert", "insert"]);
    write(update.mutations);
    const renamed = exercises().find((row) => row.id === bench.id);
    expect(renamed?.nameKey).toBe("developpe couche barre");
    const unchanged = planUpdateExercise({ exercise: renamed as Exercise, zones: ["shoulder_left", "elbow_right"], inUse: true, input: { name: "Développé couché barre", measure: "load_reps", equipment: "barbell", loadMode: "total", baseGrams: null, loadStepGrams: 1250, zones: ["elbow_right", "shoulder_left"] } }, exercises());
    expect(unchanged).toEqual({ ok: true, exerciseId: bench.id, mutations: [] });
  });

  it("edits technique cues, keeps them through other edits and undoes them", () => {
    const id = createExercise("Squat barre");
    const squat = (): Exercise => exercises().find((row) => row.id === id) as Exercise;
    expect(normalizeCues("   \n  ")).toBeNull();
    expect(planExerciseCues(squat(), "")).toBeNull();
    const cues = planExerciseCues(squat(), "Pieds sous les hanches   \n\n\n\nGenoux dans l'axe\n");
    if (cues === null) throw new Error("No cue change");
    const changesetId = write([cues], "Consignes · Squat barre");
    expect(squat().cues).toBe("Pieds sous les hanches\n\nGenoux dans l'axe");
    expect(planExerciseCues(squat(), "Pieds sous les hanches\n\nGenoux dans l'axe  ")).toBeNull();

    const update = planUpdateExercise({ exercise: squat(), zones: [], inUse: false, input: { name: "Squat barre haute", measure: "load_reps", equipment: "barbell", loadMode: "total", baseGrams: null, loadStepGrams: 2500, zones: [] } }, exercises());
    if (!update.ok) throw new Error(update.issue.kind);
    const renameId = write(update.mutations);
    expect(squat()).toMatchObject({ name: "Squat barre haute", cues: "Pieds sous les hanches\n\nGenoux dans l'axe" });

    revert(context.db, context.env, { actor: { author: "user", connectionId: null }, changesetId: renameId, summary: "Annulation", restoredVersionSummary: (number) => `Retour à la v${number}` });
    revert(context.db, context.env, { actor: { author: "user", connectionId: null }, changesetId, summary: "Annulation", restoredVersionSummary: (number) => `Retour à la v${number}` });
    expect(squat()).toMatchObject({ name: "Squat barre", cues: null });
  });
});
