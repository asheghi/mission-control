// Minimal stdio MCP server used only by the Task 1 compatibility spike.
// It registers one tool and connects the official StdioServerTransport.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "spike-stdio", version: "0.0.1" });

server.registerTool(
  "spike_echo",
  {
    description: "Echo a message back to the caller.",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: message }],
  }),
);

await server.connect(new StdioServerTransport());
