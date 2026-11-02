import { z } from "zod";
import { destructiveTools, toolContracts, toolNames } from "../contract.ts";
import type { ToolOutcome } from "../protocol.ts";

export const remoteServerVersion = "1.0.0";

const supportedProtocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

const instructions =
  "Obnixe is the user's offline sports log (strength, running, climbing, swimming, cycling, hiking, yoga). The data lives on their phone, which serves these tools itself; calls fail while the phone is off or offline. Write in French for anything the user reads (summaries, names). Quantities use base units: grams, millimeters, meters, seconds. Every write is journaled and the user can undo it from the phone. Read before you write: get_program before upsert_program, list_sports before log_activity.";

const rpcCodes = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602 } as const;

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const callParamsSchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() });

type RpcId = string | number;

export type RpcReply =
  | { readonly jsonrpc: "2.0"; readonly id: RpcId | null; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: RpcId | null; readonly error: { readonly code: number; readonly message: string } };

export type RunTool = (name: string, args: Readonly<Record<string, unknown>>) => ToolOutcome;

export interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<Record<string, unknown>>;
}

let tools: readonly McpTool[] | null = null;

function inputSchema(schema: z.ZodObject): Readonly<Record<string, unknown>> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  return rest;
}

export function listMcpTools(): readonly McpTool[] {
  tools ??= toolNames.map((name) => {
    const contract = toolContracts[name];
    const isRead = contract.kind === "read";
    return {
      name,
      title: contract.title,
      description: contract.description,
      inputSchema: inputSchema(contract.input),
      annotations: { title: contract.title, readOnlyHint: isRead, destructiveHint: destructiveTools.has(name), idempotentHint: isRead, openWorldHint: false },
    };
  });
  return tools;
}

function failure(id: RpcId | null, code: number, message: string): RpcReply {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function negotiatedVersion(params: Readonly<Record<string, unknown>> | undefined): string {
  const requested = params?.protocolVersion;
  const supported: readonly string[] = supportedProtocolVersions;
  return typeof requested === "string" && supported.includes(requested) ? requested : supportedProtocolVersions[0];
}

/** Answers one JSON-RPC message; notifications and responses from the client get no reply. */
export function answerMcpMessage(message: unknown, runTool: RunTool): RpcReply | null {
  const parsed = requestSchema.safeParse(message);
  if (!parsed.success) return failure(null, rpcCodes.invalidRequest, "Invalid JSON-RPC request");
  const { id, method, params } = parsed.data;
  if (id === undefined) return null;
  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiatedVersion(params),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "obnixe", title: "Obnixe", version: remoteServerVersion },
          instructions,
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: listMcpTools() } };
    case "tools/call": {
      const call = callParamsSchema.safeParse(params);
      if (!call.success) return failure(id, rpcCodes.invalidParams, "tools/call needs a tool name and object arguments");
      const outcome = runTool(call.data.name, call.data.arguments ?? {});
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: outcome.text }], isError: outcome.isError } };
    }
    default:
      return failure(id, rpcCodes.methodNotFound, `Method '${method}' is not supported`);
  }
}

export type McpBody = { readonly kind: "replies"; readonly replies: RpcReply | readonly RpcReply[] } | { readonly kind: "accepted" };

/** Answers a POSTed body holding one message or a batch; a body made only of notifications is accepted without content. */
export function answerMcpBody(text: string, runTool: RunTool): McpBody {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: "replies", replies: failure(null, rpcCodes.parse, "Body is not JSON") };
    throw error;
  }
  if (!Array.isArray(message)) {
    const reply = answerMcpMessage(message, runTool);
    return reply === null ? { kind: "accepted" } : { kind: "replies", replies: reply };
  }
  const replies = message.map((item: unknown) => answerMcpMessage(item, runTool)).filter((reply): reply is RpcReply => reply !== null);
  return replies.length === 0 ? { kind: "accepted" } : { kind: "replies", replies };
}
