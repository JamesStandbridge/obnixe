import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { agentCall, agentConnection, change, changeset } from "@obnixe/schema";
import type { Id, LocalDate } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { addDays, epochAt } from "../dates.ts";
import type { Actor } from "../writer.ts";
import type { ToolInput } from "./contract.ts";
import type { AgentPermission } from "./contract.ts";
import { hasPermission } from "./environment.ts";
import type { AgentEnvironment, ToolResult } from "./environment.ts";
import { loadRevertIndex, revertState } from "./history.ts";

const defaultLimit = 20;
const rangeLimit = 100;

interface GuardedTables {
  readonly permission: AgentPermission;
  readonly tables: ReadonlySet<string>;
  readonly summary: string;
}

const guardedTables: readonly GuardedTables[] = [
  { permission: "body", tables: new Set(["weigh_in", "measurement", "measurement_kind"]), summary: "Pesée ou mensurations (accès au corps désactivé)" },
  { permission: "photos", tables: new Set(["photo"]), summary: "Photos (accès aux photos désactivé)" },
];

/** Summaries quote body values, so a change touching guarded rows only shows a neutral label without the matching permission. */
function visibleSummary(env: AgentEnvironment, summary: string, tables: readonly string[]): string {
  const hidden = guardedTables.find((guard) => !hasPermission(env.permissions, guard.permission) && tables.some((table) => guard.tables.has(table)));
  return hidden?.summary ?? summary;
}

export function listAgentChanges(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"list_agent_changes">): ToolResult {
  const conditions: SQL[] = [eq(changeset.author, "agent")];
  if (input.from !== undefined && input.to !== undefined) {
    conditions.push(gte(changeset.createdAt, epochAt({ date: input.from as LocalDate, minutes: 0 }, env.timeZone)));
    conditions.push(lt(changeset.createdAt, epochAt({ date: addDays(input.to as LocalDate, 1), minutes: 0 }, env.timeZone)));
  }
  const rows = db
    .select({ id: changeset.id, summary: changeset.summary, createdAt: changeset.createdAt, connectionId: changeset.connectionId, client: agentConnection.client, host: agentConnection.host })
    .from(changeset)
    .leftJoin(agentConnection, eq(changeset.connectionId, agentConnection.id))
    .where(and(...conditions))
    .orderBy(desc(changeset.createdAt), desc(changeset.id))
    .limit(input.limit ?? (input.from === undefined ? defaultLimit : rangeLimit))
    .all();
  const ids = rows.map((row) => row.id);
  const changes = ids.length === 0 ? [] : db.select().from(change).where(inArray(change.changesetId, ids)).orderBy(asc(change.sequence)).all();
  const tools = new Map<Id | null, string>(
    (ids.length === 0 ? [] : db.select({ changesetId: agentCall.changesetId, tool: agentCall.tool }).from(agentCall).where(inArray(agentCall.changesetId, ids)).all()).map((row) => [row.changesetId, row.tool]),
  );
  const reverts = loadRevertIndex(db);
  return {
    kind: "read",
    summary: "Modifications des agents",
    data: {
      changes: rows.map((row) => {
        const touched = changes.filter((item) => item.changesetId === row.id);
        return {
          changesetId: row.id,
          createdAt: new Date(row.createdAt).toISOString(),
          summary: visibleSummary(env, row.summary, touched.map((item) => item.tableName)),
          tool: tools.get(row.id) ?? null,
          connection: { id: row.connectionId, client: row.client, host: row.host, current: row.connectionId === actor.connectionId },
          undoneByUser: revertState(reverts, row.id).reverted,
          rows: touched.map((item) => ({ table: item.tableName, id: item.rowId, operation: item.operation })),
        };
      }),
    },
  };
}
