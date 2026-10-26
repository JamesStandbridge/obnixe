import type { AgentCallKind } from "@obnixe/schema";
import { lowerFirst, plural } from "./format.ts";

export type CallTag = "Lecture" | "Modification" | "Ajout";

export interface PresentedCall {
  readonly tool: string;
  readonly kind: AgentCallKind;
  readonly summary: string;
  readonly versionNumber: number | null;
}

export function callTag(call: PresentedCall): CallTag {
  switch (call.kind) {
    case "read":
      return "Lecture";
    case "write":
      return call.tool === "upsert_program" && call.versionNumber !== null && call.versionNumber > 1 ? "Modification" : "Ajout";
    default: {
      const unreachable: never = call.kind;
      throw new Error(`Unhandled call kind ${String(unreachable)}`);
    }
  }
}

/** Title of a write in the history: program revisions carry their version, e.g. "v7 · rowing haltère au lieu du tirage menton". */
export function historyTitle(call: PresentedCall): string {
  if (call.tool === "upsert_program" && call.versionNumber !== null && call.versionNumber > 1) return `v${call.versionNumber} · ${lowerFirst(call.summary)}`;
  return call.summary;
}

const properNounTools: ReadonlySet<string> = new Set(["get_program"]);

/** "Lu : historique des 56 derniers jours, Base hiver" or null without reads. */
export function readsLine(calls: readonly Pick<PresentedCall, "tool" | "kind" | "summary">[]): string | null {
  const subjects: string[] = [];
  for (const call of calls) {
    if (call.kind !== "read") continue;
    const subject = properNounTools.has(call.tool) ? call.summary : lowerFirst(call.summary);
    if (!subjects.includes(subject)) subjects.push(subject);
  }
  return subjects.length === 0 ? null : `Lu : ${subjects.join(", ")}`;
}

export function changeCount(count: number): string {
  return plural(count, "modification", "modifications");
}

/** "Cursor · 3 lectures, 2 modifications en 29 min" */
export function connectionRecap(client: string, reads: number, writes: number, durationMs: number): string {
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  return `${client} · ${plural(reads, "lecture", "lectures")}, ${changeCount(writes)} en ${minutes} min`;
}
