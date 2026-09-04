// Task 9 black-box tests: the stateless /mcp endpoint driven by the official
// SDK client over a real Bun.serve listener, same generation as the DSH
// bridge (1.30.0).
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "../../src/db/database";
import { WorkboardService } from "../../src/app/workboard";
import { WorkboardEventBroker } from "../../src/app/events";
import { authenticate, issueToken } from "../../src/auth/service";
import { handleMcpRequest } from "../../src/api/mcp-http";
import type { Actor, Clock } from "../../src/domain/types";

function advancingClock(): Clock {
  let ticks = 0;
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return { now: () => new Date(base + (ticks += 1) * 1000).toISOString() };
}

// exactOptionalPropertyTypes: the client transport's optional sessionId is
// typed `string | undefined` by the SDK but the Transport interface differs.
function asTransport(transport: StreamableHTTPClientTransport): Transport {
  return transport as Transport;
}

interface McpFixture {
  readonly url: string;
  readonly service: WorkboardService;
  readonly aliceToken: string;
  readonly agentToken: string;
  readonly alice: Actor;
  readonly agent: Actor;
  readonly db: ReturnType<typeof initializeDatabase>;
}

async function withMcpServer(fn: (api: McpFixture) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wb-mcp-"));
  const db = initializeDatabase(dir);
  const clock = advancingClock();
  const service = new WorkboardService(db, clock, new WorkboardEventBroker());
  const bootstrap: Actor = { participantId: 0, name: "bootstrap", kind: "human" };
  const aliceP = service.createParticipant(bootstrap, { name: "alice", kind: "human" });
  const agentP = service.createParticipant(bootstrap, { name: "agent-bot", kind: "agent" });
  const aliceToken = issueToken(db, { participantId: aliceP.id, name: "alice-token", now: clock.now() }).plaintext;
  const agentToken = issueToken(db, { participantId: agentP.id, name: "agent-token", now: clock.now() }).plaintext;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      handleMcpRequest(
        { service, authenticate: (credential, now) => authenticate(db, credential, now), clock },
        request,
      ),
  });

  try {
    await fn({
      url: `http://127.0.0.1:${server.port}`,
      service,
      aliceToken,
      agentToken,
      alice: { participantId: aliceP.id, name: aliceP.name, kind: "human" },
      agent: { participantId: agentP.id, name: agentP.name, kind: "agent" },
      db,
    });
  } finally {
    server.stop(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

interface McpClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

function connectClient(url: string, token: string, headers: Record<string, string> = {}): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } },
  });
  const client = new Client({ name: "mcp-test-client", version: "0.0.1" });
  return client.connect(asTransport(transport)).then(() => ({ client, transport }));
}

function toolText(result: unknown): { parsed: any; isError: boolean } {
  const typed = result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  return { parsed: JSON.parse(typed.content[0]?.text ?? "null"), isError: typed.isError === true };
}

const EXPECTED_TOOLS = ["comment", "create_work", "get_work", "list_work", "my_work", "update_work"];

describe("stateless MCP HTTP endpoint", () => {
  test("initializes with no session id and exposes the six tools", async () => {
    await withMcpServer(async ({ url, aliceToken }) => {
      const { client, transport } = await connectClient(url, aliceToken);
      try {
        expect(transport.sessionId).toBeUndefined();
        const { tools } = await client.listTools();
        expect([...tools.map((tool) => tool.name)].sort()).toEqual(EXPECTED_TOOLS);
      } finally {
        await client.close();
      }
    });
  });

  test("create, get, list, update, comment round-trip bound to the token's actor", async () => {
    await withMcpServer(async ({ url, service, aliceToken, agentToken, agent }) => {
      service.createLabel({ participantId: 0, name: "bootstrap", kind: "human" }, { name: "bug", color: "#FF0000" });
      const alice = await connectClient(url, aliceToken);
      const agentSession = await connectClient(url, agentToken);
      try {
        const created = toolText(
          await alice.client.callTool({
            name: "create_work",
            arguments: { title: "From agent bridge", body: "please look @agent-bot", labels: ["bug"] },
          }),
        );
        expect(created.isError).toBe(false);
        expect(created.parsed.item.title).toBe("From agent bridge");
        const itemId = created.parsed.item.id;

        const fetched = toolText(await alice.client.callTool({ name: "get_work", arguments: { id: itemId } }));
        expect(fetched.parsed.item.body).toContain("@agent-bot");
        expect(fetched.parsed.comments).toHaveLength(0);

        const listed = toolText(
          await alice.client.callTool({ name: "list_work", arguments: { label: "bug", q: "bridge" } }),
        );
        expect(listed.parsed.items).toHaveLength(1);

        const assigned = toolText(
          await alice.client.callTool({
            name: "update_work",
            arguments: { id: itemId, assigneeId: agent.participantId, status: "doing" },
          }),
        );
        expect(assigned.parsed.changedFields).toEqual(["status", "assignee"]);
        expect(assigned.parsed.item.assignee?.name).toBe("agent-bot");

        const myWork = toolText(await agentSession.client.callTool({ name: "my_work", arguments: {} }));
        expect(myWork.parsed.items.map((entry: { item: { id: number } }) => entry.item.id)).toContain(itemId);

        const commented = toolText(
          await agentSession.client.callTool({ name: "comment", arguments: { id: itemId, body: "On it." } }),
        );
        expect(commented.parsed.comment.body).toBe("On it.");
        expect(commented.parsed.mentionedParticipants).toEqual([]);

        const detail = toolText(await alice.client.callTool({ name: "get_work", arguments: { id: itemId } }));
        expect(detail.parsed.comments).toHaveLength(1);
        expect(detail.parsed.item.commentCount).toBe(1);
      } finally {
        await alice.client.close();
        await agentSession.client.close();
      }
    });
  });

  test("tool-level errors come back as isError results", async () => {
    await withMcpServer(async ({ url, aliceToken }) => {
      const session = await connectClient(url, aliceToken);
      try {
        const result = await session.client.callTool({ name: "get_work", arguments: { id: 999 } });
        const typed = result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
        expect(typed.isError).toBe(true);
        expect(typed.content[0]?.text).toContain("not found");
      } finally {
        await session.client.close();
      }
    });
  });

  test("unauthenticated requests are rejected with 401", async () => {
    await withMcpServer(async ({ url }) => {
      const response = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(response.status).toBe(401);
    });
  });

  test("GET and DELETE are rejected with 405 (stateless)", async () => {
    await withMcpServer(async ({ url, aliceToken }) => {
      const get = await fetch(`${url}/mcp`, { method: "GET", headers: { Authorization: `Bearer ${aliceToken}` } });
      expect(get.status).toBe(405);
      expect(get.headers.get("Allow")).toBe("POST");
      const del = await fetch(`${url}/mcp`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${aliceToken}`, "mcp-session-id": "whatever" },
      });
      expect(del.status).toBe(405);
    });
  });

  test("non-loopback origins are rejected with 403", async () => {
    await withMcpServer(async ({ url, aliceToken }) => {
      let rejected = false;
      try {
        await connectClient(url, aliceToken, { Origin: "https://evil.example" });
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    });
  });

  test("authenticates before consuming the body: unauthenticated oversize gets 401", async () => {
    await withMcpServer(async ({ url }) => {
      const hugePadding = "x".repeat(1_200_000);
      const response = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", padding: hugePadding }),
      });
      expect(response.status).toBe(401);
    });
  });

  test("the body cap counts bytes, not UTF-16 code units", async () => {
    await withMcpServer(async ({ url, aliceToken }) => {
      // "€" is 3 bytes in UTF-8: ~1.2 MB of bytes but only ~400k code units, so
      // only a byte-accurate cap rejects this as 413.
      const multibytePadding = "€".repeat(400_000);
      const response = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", padding: multibytePadding }),
      });
      expect(response.status).toBe(413);
      const payload = (await response.json()) as { error?: { code?: string } };
      expect(payload.error?.code).toBe("PAYLOAD_TOO_LARGE");
    });
  });
});
