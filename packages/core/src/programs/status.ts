import type { Id, Program } from "@obnixe/schema";
import type { Mutation } from "../writer.ts";

export type StatusRefusal = "not_found" | "already_active" | "already_archived";

export type StatusPlan =
  | { readonly ok: true; readonly mutations: readonly [Mutation, ...Mutation[]]; readonly archived: Program | null }
  | { readonly ok: false; readonly refusal: StatusRefusal };

export function planActivate(programs: readonly Program[], programId: Id): StatusPlan {
  const target = programs.find((program) => program.id === programId);
  if (target === undefined) return { ok: false, refusal: "not_found" };
  if (target.status === "active") return { ok: false, refusal: "already_active" };
  const current = programs.find((program) => program.status === "active") ?? null;
  const activate: Mutation = { kind: "update", table: "program", key: programId, patch: { status: "active" } };
  if (current === null) return { ok: true, mutations: [activate], archived: null };
  return { ok: true, mutations: [{ kind: "update", table: "program", key: current.id, patch: { status: "archived" } }, activate], archived: current };
}

export function planArchive(program: Program): StatusPlan {
  if (program.status === "archived") return { ok: false, refusal: "already_archived" };
  return { ok: true, mutations: [{ kind: "update", table: "program", key: program.id, patch: { status: "archived" } }], archived: program };
}
