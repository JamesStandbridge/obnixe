import { DrizzleQueryError } from "drizzle-orm";
import { ZodError, z } from "zod";
import { agentCall } from "@obnixe/schema";
import type { Id } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import { DependentRowsError, DuplicateRowError, RowNotFoundError } from "../writer.ts";
import type { Actor } from "../writer.ts";
import { isConnectionOpen, readPermissions } from "./connection.ts";
import { isToolName, toolContracts } from "./contract.ts";
import type { AgentPermission, ToolInput, ToolName } from "./contract.ts";
import { PermissionDeniedError, ToolInputError, hasPermission } from "./environment.ts";
import type { AgentEnvironment, ToolResult } from "./environment.ts";
import type { ToolOutcome } from "./protocol.ts";
import { getBodySignals, getExerciseProgress, getHistory, getProgram, listExercises, listPhotos, listPrograms, listSports } from "./reads.ts";
import { createExercise, logActivity, logStrengthSession, upsertProgram } from "./writes.ts";

type Handler<N extends ToolName> = (db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<N>) => ToolResult;

const handlers: { readonly [N in ToolName]: Handler<N> } = {
  list_sports: () => listSports(),
  get_history: (db, env, _actor, input) => getHistory(db, env, input),
  get_exercise_progress: (db, env, _actor, input) => getExerciseProgress(db, env, input),
  get_body_signals: (db, env, _actor, input) => getBodySignals(db, env, input),
  list_photos: (db, env, _actor, input) => listPhotos(db, env, input),
  list_programs: (db) => listPrograms(db),
  get_program: (db, env, _actor, input) => getProgram(db, env, input),
  list_exercises: (db, env, _actor, input) => listExercises(db, env, input),
  create_exercise: createExercise,
  upsert_program: upsertProgram,
  log_activity: logActivity,
  log_strength_session: logStrengthSession,
};

export interface AgentCallRequest {
  readonly connectionId: Id;
  readonly tool: string;
  readonly arguments: unknown;
  readonly timeZone: string;
}

function failure(text: string): ToolOutcome {
  return { text, isError: true };
}

function execute<N extends ToolName>(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, name: N, args: unknown): ToolResult {
  const input = toolContracts[name].input.parse(args) as ToolInput<N>;
  const handler: Handler<N> = handlers[name];
  return handler(db, env, actor, input);
}

/** Runs one agent tool call against the local database, journals it as an agent_call and maps expected failures to tool errors. */
export function runAgentTool(db: ObnixeDatabase, env: Environment, request: AgentCallRequest): ToolOutcome {
  if (!isToolName(request.tool)) return failure(`Unknown tool '${request.tool}'.`);
  if (!isConnectionOpen(db, request.connectionId)) return failure("The connection to the phone was closed. Ask the user to pair again.");
  const name = request.tool;
  const contract = toolContracts[name];
  const permissions = readPermissions(db);
  const agentEnv: AgentEnvironment = { now: env.now, newId: env.newId, timeZone: request.timeZone, permissions };
  const actor: Actor = { author: "agent", connectionId: request.connectionId };
  try {
    const missing: AgentPermission | undefined = contract.permissions.find((permission) => !hasPermission(permissions, permission));
    if (missing !== undefined) throw new PermissionDeniedError(missing);
    const result = db.transaction((tx) => {
      const outcome = execute(tx, agentEnv, actor, name, request.arguments);
      tx.insert(agentCall)
        .values({
          id: env.newId(),
          connectionId: request.connectionId,
          tool: name,
          kind: outcome.kind,
          summary: outcome.summary,
          changesetId: outcome.kind === "write" ? outcome.changesetId : null,
          calledAt: env.now(),
        })
        .run();
      return outcome;
    });
    return { text: JSON.stringify(result.data), isError: false };
  } catch (error) {
    if (error instanceof ZodError) return failure(`Invalid input:\n${z.prettifyError(error)}`);
    if (error instanceof ToolInputError || error instanceof PermissionDeniedError) return failure(error.message);
    if (error instanceof RowNotFoundError || error instanceof DuplicateRowError || error instanceof DependentRowsError) return failure(error.message);
    if (error instanceof DrizzleQueryError) return failure(`Rejected by the database: ${error.cause instanceof Error ? error.cause.message : error.message}`);
    throw error;
  }
}
