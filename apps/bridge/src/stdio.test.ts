import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";

it("runs under node type stripping and serves MCP over stdio", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./main.ts", import.meta.url))],
    env: { ...process.env, OBNIXE_PHONE_PORT: "0", OBNIXE_CONTROL_PORT: "0" } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "codex-mcp-client", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  expect(tools).toHaveLength(12);
  const result = await client.callTool({ name: "list_programs", arguments: {} });
  expect(result.isError).toBe(true);
  await client.close();
}, 20_000);
