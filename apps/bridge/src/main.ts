#!/usr/bin/env -S node --experimental-strip-types
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { catalogVersion, sports } from "@obnixe/schema";

const server = new McpServer({ name: "obnixe-bridge", version: "0.0.0" });

server.registerTool(
  "list_sports",
  {
    title: "Sports",
    description: "List the sports supported by Obnixe with their session and item fields.",
  },
  () => ({
    content: [{ type: "text", text: JSON.stringify({ catalogVersion, sports }) }],
  }),
);

await server.connect(new StdioServerTransport());
