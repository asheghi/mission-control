// Task 8 black-box HTTP tests: every endpoint is exercised through a real
// Bun.serve instance with fetch — no direct service calls in assertions
// unless seeding (tokens) or driving SSE mutations.
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "../../../src/db/database";
import { WorkboardService } from "../../../src/app/workboard";
import { WorkboardEventBroker } from "../../../src/app/events";
import { authenticate, issueToken, revokeTokenById } from "../../../src/auth/service";
import { createApiHandler } from "../../../src/api/app";
import type { Actor, Clock } from "../../../src/domain/types";

function advancingClock(): Clock {
  let ticks = 0;
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return { now: () => new Date(base + (ticks += 1) * 1000).toISOString() };
}

interface ApiFixture {
  readonly url: string;
  readonly service: WorkboardService;
  readonly db: Database;
  readonly broker: WorkboardEventBroker;
  readonly aliceToken: string;
  readonly agentToken: string;
  readonly alice: Actor;
  readonly agent: Actor;
}

async function withApi(
  fn: (api: ApiFixture) => Promise<void>,
  overrides: { maxBodyBytes?: number; heartbeatMs?: number } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wb-api-"));
  const db = initializeDatabase(dir);
  const broker = new WorkboardEventBroker();
  const clock = advancingClock();
  const service = new WorkboardService(db, clock, broker);
  const bootstrap: Actor = { participantId: 0, name: "bootstrap", kind: "human" };
  const aliceP = service.createParticipant(bootstrap, { name: "alice", kind: "human" });
  const agentP = service.createParticipant(bootstrap, { name: "agent-bot", kind: "agent" });
  const aliceToken = issueToken(db, { participantId: aliceP.id, name: "alice-token", now: clock.now() }).plaintext;
  const agentToken = issueToken(db, { participantId: agentP.id, name: "agent-token", now: clock.now() }).plaintext;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createApiHandler({
      service,
      broker,
      authenticate: (credential, now) => authenticate(db, credential, now),
      clock,
      ...(overrides.maxBodyBytes !== undefined ? { maxBodyBytes: overrides.maxBodyBytes } : {}),
      heartbeatMs: overrides.heartbeatMs ?? 30,
    }),
  });

  try {
    await fn({
      url: `http://127.0.0.1:${server.port}`,
      service,
      db,
      broker,
      aliceToken,
      agentToken,
      alice: { participantId: aliceP.id, name: aliceP.name, kind: "human" },
      agent: { participantId: agentP.id, name: agentP.name, kind: "agent" },
    });
  } finally {
    server.stop(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function probe(responsePromise: Promise<Response> | Response): Promise<{
  status: number;
  body: any;
  requestId: string | null;
  headers: { get(name: string): string | null };
}> {
  const response = await responsePromise;
  return { status: response.status, body: await response.json(), requestId: response.headers.get("x-request-id"), headers: response.headers };
}

describe("REST API", () => {
  test("health endpoint needs no auth and echoes correlation id", async () => {
    await withApi(async ({ url }) => {
      const result = await probe(fetch(`${url}/api/health`, { headers: { "X-Request-Id": "corr-1" } }));
      expect(result.status).toBe(200);
      expect(result.body.data.status).toBe("ok");
      expect(result.requestId).toBe("corr-1");
    });
  });

  test("missing, malformed, and revoked credentials all yield identical 401s", async () => {
    await withApi(async ({ url, db, aliceToken, alice }) => {
      const noAuth = await probe(fetch(`${url}/api/items`));
      expect(noAuth.status).toBe(401);
      expect(noAuth.body.error.code).toBe("UNAUTHENTICATED");

      const garbage = await probe(fetch(`${url}/api/items`, { headers: { Authorization: "Bearer nonsense" } }));
      expect(garbage.status).toBe(401);
      expect(garbage.body.error.code).toBe("UNAUTHENTICATED");

      const issued = issueToken(db, { participantId: alice.participantId, name: "short-lived", now: "2026-01-01T00:10:00.000Z" });
      revokeTokenById(db, issued.token.id, "2026-01-01T00:11:00.000Z");
      const revoked = await probe(fetch(`${url}/api/items`, { headers: auth(issued.plaintext) }));
      expect(revoked.status).toBe(401);
      expect(revoked.body.error.code).toBe("UNAUTHENTICATED");
      expect(revoked.body.error.message).toBe(noAuth.body.error.message);
      void aliceToken;
    });
  });

  test("item lifecycle: create, read, patch, delete through HTTP", async () => {
    await withApi(async ({ url, aliceToken, agentToken, agent }) => {
      const created = await probe(
        fetch(`${url}/api/items`, {
          method: "POST",
          headers: { ...auth(aliceToken), "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Ship it", body: "ping @agent-bot", priority: 3 }),
        }),
      );
      expect(created.status).toBe(201);
      const itemId = created.body.data.item.id;
      expect(created.body.data.item.status).toBe("todo");
      expect(created.body.data.item.commentCount).toBe(0);
      expect(created.body.data.history).toHaveLength(1);

      const fetched = await probe(fetch(`${url}/api/items/${itemId}`, { headers: auth(aliceToken) }));
      expect(fetched.status).toBe(200);
      expect(fetched.body.data.item.title).toBe("Ship it");

      const patched = await probe(
        fetch(`${url}/api/items/${itemId}`, {
          method: "PATCH",
          headers: { ...auth(aliceToken), "Content-Type": "application/json" },
          body: JSON.stringify({ status: "doing", assigneeId: agent.participantId }),
        }),
      );
      expect(patched.status).toBe(200);
      expect(patched.body.data.changedFields).toEqual(["status", "assignee"]);

      // Different-field patches from two participants do not clobber each other.
      const patchA = await probe(
        fetch(`${url}/api/items/${itemId}`, {
          method: "PATCH",
          headers: { ...auth(aliceToken), "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Renamed" }),
        }),
      );
      const patchB = await probe(
        fetch(`${url}/api/items/${itemId}`, {
          method: "PATCH",
          headers: { ...auth(agentToken), "Content-Type": "application/json" },
          body: JSON.stringify({ priority: 1 }),
        }),
      );
      expect(patchA.status).toBe(200);
      expect(patchB.status).toBe(200);
      const detail = await probe(fetch(`${url}/api/items/${itemId}`, { headers: auth(aliceToken) }));
      expect(detail.body.data.item.title).toBe("Renamed");
      expect(detail.body.data.item.priority).toBe(1);
      expect(detail.body.data.item.assignee?.id).toBe(agent.participantId);

      const noOp = await probe(
        fetch(`${url}/api/items/${itemId}`, {
          method: "PATCH",
          headers: { ...auth(aliceToken), "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Renamed" }),
        }),
      );
      expect(noOp.body.data.changedFields).toEqual([]);

      const deleted = await probe(fetch(`${url}/api/items/${itemId}`, { method: "DELETE", headers: auth(aliceToken) }));
      expect(deleted.status).toBe(200);
      expect(deleted.body.data.deleted).toBe(true);

      const gone = await probe(fetch(`${url}/api/items/${itemId}`, { headers: auth(aliceToken) }));
      expect(gone.status).toBe(404);
      expect(gone.body.error.code).toBe("NOT_FOUND");
    });
  });

  test("invalid inputs, spoofed actor fields, and malformed JSON are 400s", async () => {
    await withApi(async ({ url, aliceToken }) => {
      const headers = { ...auth(aliceToken), "Content-Type": "application/json" };

      const empty = await probe(fetch(`${url}/api/items`, { method: "POST", headers, body: "{}" }));
      expect(empty.status).toBe(400);
      expect(empty.body.error.code).toBe("VALIDATION");
      expect(empty.body.error.details.issues.length).toBeGreaterThan(0);

      const spoofed = await probe(
        fetch(`${url}/api/items`, { method: "POST", headers, body: JSON.stringify({ title: "x", createdBy: 99 }) }),
      );
      expect(spoofed.status).toBe(400);
      expect(spoofed.body.error.code).toBe("VALIDATION");

      const malformed = await probe(fetch(`${url}/api/items`, { method: "POST", headers, body: "{oops" }));
      expect(malformed.status).toBe(400);
      expect(malformed.body.error.code).toBe("VALIDATION");

      const badQuery = await probe(fetch(`${url}/api/items?limit=nope`, { headers: auth(aliceToken) }));
      expect(badQuery.status).toBe(400);
    });
  });

  test("comments create, mention, and surface in detail", async () => {
    await withApi(async ({ url, aliceToken, agentToken }) => {
      const created = await probe(
        fetch(`${url}/api/items`, {
          method: "POST",
          headers: { ...auth(aliceToken), "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Commented" }),
        }),
      );
      const itemId = created.body.data.item.id;

      const comment = await probe(
        fetch(`${url}/api/items/${itemId}/comments`, {
          method: "POST",
          headers: { ...auth(agentToken), "Content-Type": "application/json" },
          body: JSON.stringify({ body: "On it. cc @alice" }),
        }),
      );
      expect(comment.status).toBe(201);
      expect(comment.body.data.comment.author.name).toBe("agent-bot");
      expect(comment.body.data.mentionedParticipants.map((p: { name: string }) => p.name)).toEqual(["alice"]);

      const detail = await probe(fetch(`${url}/api/items/${itemId}`, { headers: auth(aliceToken) }));
      expect(detail.body.data.comments).toHaveLength(1);

      const work = await probe(fetch(`${url}/api/me/work`, { headers: auth(aliceToken) }));
      expect(work.body.data.map((w: { item: { id: number } }) => w.item.id)).toContain(itemId);

      const blank = await probe(
        fetch(`${url}/api/items/${itemId}/comments`, {
          method: "POST",
          headers: { ...auth(agentToken), "Content-Type": "application/json" },
          body: JSON.stringify({ body: "   " }),
        }),
      );
      expect(blank.status).toBe(400);
    });
  });

  test("participants and labels endpoints with conflict mapping", async () => {
    await withApi(async ({ url, aliceToken }) => {
      const headers = { ...auth(aliceToken), "Content-Type": "application/json" };

      const listed = await probe(fetch(`${url}/api/participants`, { headers: auth(aliceToken) }));
      expect(listed.body.data).toHaveLength(2);

      const created = await probe(
        fetch(`${url}/api/participants`, { method: "POST", headers, body: JSON.stringify({ name: "carol", kind: "human" }) }),
      );
      expect(created.status).toBe(201);
      expect(created.body.data.avatarColor).toMatch(/^#[0-9A-Fa-f]{6}$/);

      const duplicate = await probe(
        fetch(`${url}/api/participants`, { method: "POST", headers, body: JSON.stringify({ name: "CAROL", kind: "human" }) }),
      );
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe("CONFLICT");

      const label = await probe(fetch(`${url}/api/labels`, { method: "POST", headers, body: JSON.stringify({ name: "bug", color: "#FF0000" }) }));
      expect(label.status).toBe(201);

      const labelDupe = await probe(fetch(`${url}/api/labels`, { method: "POST", headers, body: JSON.stringify({ name: "bug", color: "#00FF00" }) }));
      expect(labelDupe.status).toBe(409);

      const labels = await probe(fetch(`${url}/api/labels`, { headers: auth(aliceToken) }));
      expect(labels.body.data).toHaveLength(1);
    });
  });

  test("list filters and cursor pagination over HTTP", async () => {
    await withApi(async ({ url, aliceToken, agent }) => {
      const headers = { ...auth(aliceToken), "Content-Type": "application/json" };
      await probe(fetch(`${url}/api/labels`, { method: "POST", headers, body: JSON.stringify({ name: "bug", color: "#FF0000" }) }));
      await probe(fetch(`${url}/api/items`, { method: "POST", headers, body: JSON.stringify({ title: "one", labels: ["bug"] }) }));
      await probe(fetch(`${url}/api/items`, { method: "POST", headers, body: JSON.stringify({ title: "two" }) }));
      const third = await probe(fetch(`${url}/api/items`, { method: "POST", headers, body: JSON.stringify({ title: "three" }) }));
      const thirdId = third.body.data.item.id;
      await probe(
        fetch(`${url}/api/items/${thirdId}`, { method: "PATCH", headers, body: JSON.stringify({ status: "doing", assigneeId: agent.participantId }) }),
      );

      const byLabel = await probe(fetch(`${url}/api/items?label=bug`, { headers: auth(aliceToken) }));
      expect(byLabel.body.data.map((i: { title: string }) => i.title)).toEqual(["one"]);

      const byStatus = await probe(fetch(`${url}/api/items?status=todo`, { headers: auth(aliceToken) }));
      expect(byStatus.body.data).toHaveLength(2);

      const byQ = await probe(fetch(`${url}/api/items?q=tw`, { headers: auth(aliceToken) }));
      expect(byQ.body.data.map((i: { title: string }) => i.title)).toEqual(["two"]);

      const unassigned = await probe(fetch(`${url}/api/items?assignee=unassigned`, { headers: auth(aliceToken) }));
      expect(unassigned.body.data).toHaveLength(2);

      const byAssigneeName = await probe(fetch(`${url}/api/items?assignee=agent-bot`, { headers: auth(aliceToken) }));
      expect(byAssigneeName.body.data.map((i: { title: string }) => i.title)).toEqual(["three"]);

      const unknownAssignee = await probe(fetch(`${url}/api/items?assignee=nobody`, { headers: auth(aliceToken) }));
      expect(unknownAssignee.body.data).toEqual([]);

      const page1 = await probe(fetch(`${url}/api/items?limit=2`, { headers: auth(aliceToken) }));
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.meta.nextCursor).not.toBeNull();
      const page2 = await probe(fetch(`${url}/api/items?limit=2&cursor=${encodeURIComponent(page1.body.meta.nextCursor)}`, { headers: auth(aliceToken) }));
      expect([...page1.body.data, ...page2.body.data]).toHaveLength(3);
    });
  });

  test("oversized request bodies are rejected with 413", async () => {
    await withApi(
      async ({ url, aliceToken }) => {
        const result = await probe(
          fetch(`${url}/api/items`, {
            method: "POST",
            headers: { ...auth(aliceToken), "Content-Type": "application/json" },
            body: JSON.stringify({ title: "x".repeat(500) }),
          }),
        );
        expect(result.status).toBe(413);
        expect(result.body.error.code).toBe("PAYLOAD_TOO_LARGE");
      },
      { maxBodyBytes: 128 },
    );
  });

  test("method mismatch yields 405 with Allow header", async () => {
    await withApi(async ({ url, aliceToken }) => {
      const result = await probe(fetch(`${url}/api/health`, { method: "PATCH", headers: auth(aliceToken) }));
      expect(result.status).toBe(405);
      expect(result.body.error.code).toBe("METHOD_NOT_ALLOWED");
      expect(result.headers.get("Allow")).toContain("GET");
    });
  });

  test("unknown paths yield 404 envelope", async () => {
    await withApi(async ({ url, aliceToken }) => {
      const result = await probe(fetch(`${url}/api/definitely-not-here`, { headers: auth(aliceToken) }));
      expect(result.status).toBe(404);
      expect(result.body.error.code).toBe("NOT_FOUND");
    });
  });

  test("SSE streams heartbeats and events, and abort cleans up", async () => {
    await withApi(
      async ({ url, service, aliceToken, broker, alice }) => {
        const controller = new AbortController();
        const response = await fetch(`${url}/api/events`, { headers: auth(aliceToken), signal: controller.signal });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");

        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let text = "";
        const readUntil = async (needle: string, deadlineMs: number): Promise<boolean> => {
          const deadline = Date.now() + deadlineMs;
          while (Date.now() < deadline && !text.includes(needle)) {
            const chunk = await Promise.race([
              reader.read(),
              new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
            ]);
            if (chunk !== "timeout" && chunk.value) text += decoder.decode(chunk.value, { stream: true });
          }
          return text.includes(needle);
        };

        expect(await readUntil(": connected", 2000)).toBe(true);
        expect(await readUntil(": heartbeat", 2000)).toBe(true);

        const created = service.createItem(alice, { title: "Live" });
        expect(await readUntil("event: item.created", 2000)).toBe(true);
        expect(text).toContain('"type":"item.created"');
        expect(text).toContain(`"itemId":${created.item.id}`);

        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(broker.subscriberCount()).toBe(0);
        void aliceToken;
      },
      { heartbeatMs: 30 },
    );
  });

  test("SSE requires authentication", async () => {
    await withApi(async ({ url }) => {
      const response = await fetch(`${url}/api/events`);
      expect(response.status).toBe(401);
    });
  });
});
