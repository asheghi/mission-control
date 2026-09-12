import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkboardEventBroker } from "../../../src/app/events";
import { WorkboardService } from "../../../src/app/workboard";
import { createApiHandler } from "../../../src/api/app";
import { authenticate, issueToken } from "../../../src/auth/service";
import { initializeDatabase } from "../../../src/db/database";
import type { Actor, Clock } from "../../../src/domain/types";
import { createLogger } from "../../../src/observability/logger";

const clock: Clock = { now: () => "2026-01-01T00:00:00.000Z" };

describe("request observability integration", () => {
  test("REST and MCP emit exactly one redacted transport record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-observe-"));
    const db = initializeDatabase(dir);
    const broker = new WorkboardEventBroker();
    const service = new WorkboardService(db, clock, broker);
    const bootstrap: Actor = { participantId: 0, name: "bootstrap", kind: "human" };
    const participant = service.createParticipant(bootstrap, { name: "logger-user", kind: "human" });
    const token = issueToken(db, { participantId: participant.id, name: "test", now: clock.now() }).plaintext;
    const lines: string[] = [];
    let duration = 0;
    const handler = createApiHandler({
      service,
      broker,
      authenticate: (credential, now) => authenticate(db, credential, now),
      clock,
      logger: createLogger({ sink: (line) => lines.push(line) }),
      durationClock: { nowMs: () => ++duration },
    });
    try {
      const restRequestId = "123e4567-e89b-42d3-a456-426614174001";
      const mcpRequestId = "123e4567-e89b-42d3-a456-426614174002";
      const rest = await handler(new Request(`http://127.0.0.1/api/items?q=${encodeURIComponent(token)}`, {
        headers: { Authorization: `Bearer ${token}`, "X-Request-Id": restRequestId },
      }));
      expect(rest.status).toBe(200);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        requestId: restRequestId, transport: "rest", method: "GET", pathname: "/api/items",
        participantId: participant.id, status: 200, outcome: "ok",
      });

      const mcp = await handler(new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Request-Id": mcpRequestId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }));
      expect(mcp.status).toBe(200);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
        requestId: mcpRequestId, transport: "mcp-http", method: "POST", pathname: "/mcp",
        participantId: participant.id, status: 200, outcome: "ok",
      });
      expect(lines.join("\n")).not.toContain(token);
      expect(lines.join("\n")).not.toContain("Authorization");
      expect(lines.join("\n")).not.toContain("q=");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("authentication failure omits participant and logs once", async () => {
    const lines: string[] = [];
    const broker = new WorkboardEventBroker();
    const dir = mkdtempSync(join(tmpdir(), "wb-observe-auth-"));
    const db = initializeDatabase(dir);
    const service = new WorkboardService(db, clock, broker);
    const handler = createApiHandler({
      service,
      broker,
      authenticate: (credential, now) => authenticate(db, credential, now),
      clock,
      logger: createLogger({ sink: (line) => lines.push(line) }),
    });
    try {
      const response = await handler(new Request("http://127.0.0.1/api/items"));
      expect(response.status).toBe(401);
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0] ?? "{}");
      expect(record.outcome).toBe("UNAUTHENTICATED");
      expect("participantId" in record).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
