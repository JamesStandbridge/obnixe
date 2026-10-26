import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { destructiveTools, toolContracts, toolNames } from "@obnixe/core/agent/wire";
import type { ToolName } from "@obnixe/core/agent/wire";
import type { PhoneEndpoint } from "./phone.ts";

export const bridgeVersion = "0.1.0";

const instructions =
  "Obnixe is the user's offline sports log (strength, running, climbing, swimming, cycling, hiking, yoga). The data lives on their phone; these tools only work while the phone shows the Agent screen and is paired. Write in French for anything the user reads (summaries, names). Quantities use base units: grams, millimeters, meters, seconds. Every write is journaled and the user can undo it from the phone. Read before you write: get_program before upsert_program, list_sports before log_activity.";

export function clientLabel(name: string | undefined): string {
  if (name === undefined || name.trim() === "") return "Agent";
  if (/cursor/i.test(name)) return "Cursor";
  if (/codex/i.test(name)) return "Codex";
  if (/claude/i.test(name)) return "Claude";
  if (/vscode|visual studio code/i.test(name)) return "VS Code";
  return name.trim().slice(0, 40);
}

export function hostLabel(): string {
  if (process.platform === "darwin") {
    const result = spawnSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" });
    const name = result.status === 0 ? result.stdout.trim() : "";
    if (name !== "") return name;
  }
  return hostname().replace(/\.local$/, "");
}

export function createMcpServer(endpoint: PhoneEndpoint): McpServer {
  const server = new McpServer({ name: "obnixe", title: "Obnixe", version: bridgeVersion }, { instructions });
  for (const name of toolNames) register(server, endpoint, name);
  server.server.oninitialized = () => {
    endpoint.setClient(clientLabel(server.server.getClientVersion()?.name));
  };
  return server;
}

function register(server: McpServer, endpoint: PhoneEndpoint, name: ToolName): void {
  const contract = toolContracts[name];
  const isRead = contract.kind === "read";
  server.registerTool(
    name,
    {
      title: contract.title,
      description: contract.description,
      inputSchema: contract.input,
      annotations: { title: contract.title, readOnlyHint: isRead, destructiveHint: destructiveTools.has(name), idempotentHint: isRead, openWorldHint: false },
    },
    async (args: Readonly<Record<string, unknown>>): Promise<CallToolResult> => {
      const outcome = await endpoint.callTool(name, args);
      return { content: [{ type: "text", text: outcome.text }], isError: outcome.isError };
    },
  );
}
