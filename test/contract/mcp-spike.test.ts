// Task 1 compatibility spike (docs/plans/main-product-implementation.md §7 Task 1).
//
// Proves, against the exact @modelcontextprotocol/sdk generation used by the
// installed DSH bridge (1.30.0):
//   1. an in-memory bun:sqlite database opens,
//   2. an official-SDK MCP server works over stdio under Bun,
//   3. a stateless Streamable HTTP endpoint initializes, lists, and serves tool
//      calls without ever issuing an MCP-Session-Id (2025-era stateless pattern;
//      the installed SDK generation's latest protocol revision is 2025-11-25).
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { z } from "zod";

const SPIKE_TOOL = "spike_echo";
const MAX_SPIKE_BODY_BYTES = 1_000_000;

interface SpikeState {
  readonly initializeProtocolVersions: string[];
  readonly responses: { status: number; sessionIdHeader: string | null }[];
}

// The SDK types the client transport's sessionId as `string | undefined`,
// which the Transport interface's optional property rejects under
// exactOptionalPropertyTypes. Runtime behavior is the documented one.
function asTransport(transport: StreamableHTTPClientTransport): Transport {
  return transport as Transport;
}

function createSpikeToolServer(): McpServer {
  const server = new McpServer({ name: "spike-http", version: "0.0.1" });
  server.registerTool(
    SPIKE_TOOL,
    {
      description: "Echo a message back to the caller.",
      inputSchema: { message: z.string() },
    },
    async ({ message }) => ({ content: [{ type: "text", text: message }] }),
  );
  return server;
}

function createSpikeFetch(state: SpikeState): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") {
      return new Response(null, { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }

    const raw = await request.text();
    if (raw.length > MAX_SPIKE_BODY_BYTES) {
      return new Response(null, { status: 413 });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new Response(null, { status: 400 });
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "method" in parsed &&
      (parsed as { method: unknown }).method === "initialize"
    ) {
      const offered = (parsed as { params?: { protocolVersion?: unknown } }).params?.protocolVersion;
      if (typeof offered === "string") state.initializeProtocolVersions.push(offered);
    }

    // Stateless 2025-era pattern: a fresh server + transport per POST. The SDK
    // treats an absent sessionIdGenerator exactly like the documented
    // `sessionIdGenerator: undefined` (session management disabled).
    const mcpServer = createSpikeToolServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    request.signal.addEventListener("abort", () => {
      void transport.close();
      void mcpServer.close();
    });
    await mcpServer.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody: parsed });
    void transport.close();
    void mcpServer.close();
    return response;
  };
}

describe("mcp compatibility spike", () => {
  test("opens an in-memory bun:sqlite database", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE spike (value TEXT NOT NULL)");
      db.prepare("INSERT INTO spike (value) VALUES (?)").run("ok");
      const row = db.prepare("SELECT value FROM spike").get() as { value: string };
      expect(row.value).toBe("ok");
    } finally {
      db.close();
    }
  });

  test(
    "official client drives a minimal stdio MCP server",
    async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["run", join(import.meta.dir, "../fixtures/stdio-spike-server.ts")],
      });
      const client = new Client({ name: "spike-client", version: "0.0.1" });
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toContain(SPIKE_TOOL);

        const result = (await client.callTool({
          name: SPIKE_TOOL,
          arguments: { message: "hello from stdio" },
        })) as { content: Array<{ type: string; text?: string }> };
        expect(result.content[0]?.text).toBe("hello from stdio");
      } finally {
        await client.close();
      }
    },
    20_000,
  );

  test(
    "stateless Streamable HTTP: initialize, list, call, and never an MCP-Session-Id",
    async () => {
      const state: SpikeState = { initializeProtocolVersions: [], responses: [] };
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          const response = await createSpikeFetch(state)(request);
          state.responses.push({
            status: response.status,
            sessionIdHeader: response.headers.get("mcp-session-id"),
          });
          return response;
        },
      });

      try {
        // First independent client: full initialize → list → call cycle.
        const firstClient = new Client({ name: "spike-client", version: "0.0.1" });
        const firstTransport = new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${server.port}/mcp`),
        );
        await firstClient.connect(asTransport(firstTransport));
        expect(firstTransport.sessionId).toBeUndefined();

        const { tools } = await firstClient.listTools();
        expect(tools.map((tool) => tool.name)).toContain(SPIKE_TOOL);

        const result = (await firstClient.callTool({
          name: SPIKE_TOOL,
          arguments: { message: "hello over http" },
        })) as { content: Array<{ type: string; text?: string }> };
        expect(result.content[0]?.text).toBe("hello over http");
        await firstClient.close();

        // Second independent client with no shared state must also work.
        const secondClient = new Client({ name: "spike-client-2", version: "0.0.1" });
        const secondTransport = new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${server.port}/mcp`),
        );
        await secondClient.connect(asTransport(secondTransport));
        expect(secondTransport.sessionId).toBeUndefined();
        const again = (await secondClient.callTool({
          name: SPIKE_TOOL,
          arguments: { message: "second client" },
        })) as { content: Array<{ type: string; text?: string }> };
        expect(again.content[0]?.text).toBe("second client");
        await secondClient.close();

        // The installed SDK generation is a 2025-era client; record the revision.
        console.info("[spike] negotiated MCP protocol revision: 2025-11-25");
        expect(state.initializeProtocolVersions.length).toBeGreaterThan(0);
        for (const version of state.initializeProtocolVersions) {
          expect(version).toBe("2025-11-25");
        }

        // Stateless guarantee: no response ever issues a session id.
        expect(state.responses.length).toBeGreaterThan(0);
        for (const response of state.responses) {
          expect(response.sessionIdHeader).toBeNull();
        }
      } finally {
        server.stop(true);
      }
    },
    20_000,
  );
});
