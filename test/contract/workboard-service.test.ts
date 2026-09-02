// Task 6 contract tests: WorkboardService only — no HTTP or MCP imports.
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { WorkboardService } from "../../src/app/workboard";
import { WorkboardEventBroker } from "../../src/app/events";
import type { EventPublisher, WorkboardEvent } from "../../src/app/events";
import type { Actor, Clock } from "../../src/domain/types";
import { ConflictError, NotFoundError, ValidationError } from "../../src/domain/errors";
import { withTempDatabase } from "../helpers/temp-dir";

function advancingClock(): Clock {
  let ticks = 0;
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return { now: () => new Date(base + (ticks += 1) * 1000).toISOString() };
}

interface Fixture {
  readonly service: WorkboardService;
  readonly alice: Actor;
  readonly agent: Actor;
}

function withFixture(
  fn: (fx: Fixture, db: Database) => void,
  clock: Clock = advancingClock(),
  events?: EventPublisher,
): void {
  withTempDatabase((db) => {
    const service = new WorkboardService(db, clock, events);
    const bootstrap: Actor = { participantId: 0, name: "bootstrap", kind: "human" };
    const alice = service.createParticipant(bootstrap, { name: "alice", kind: "human" });
    const bot = service.createParticipant(bootstrap, { name: "bot", kind: "agent" });
    fn(
      {
        service,
        alice: { participantId: alice.id, name: alice.name, kind: alice.kind },
        agent: { participantId: bot.id, name: bot.name, kind: bot.kind },
      },
      db,
    );
  });
}

describe("WorkboardService items", () => {
  test("createItem records creator, mentions, labels, and created history", () => {
    withFixture(({ service, alice, agent }) => {
      service.createLabel(alice, { name: "bug", color: "#FF0000" });
      const detail = service.createItem(alice, {
        title: "Fix the parser",
        body: "It crashes. ping @bot",
        priority: 3,
        assigneeId: agent.participantId,
        labels: ["bug"],
      });

      expect(detail.item.title).toBe("Fix the parser");
      expect(detail.item.status).toBe("todo");
      expect(detail.item.priority).toBe(3);
      expect(detail.item.assignee?.id).toBe(agent.participantId);
      expect(detail.item.createdBy).toBe(alice.participantId);
      expect(detail.item.labels.map((l) => l.name)).toEqual(["bug"]);
      expect(detail.item.commentCount).toBe(0);
      expect(detail.history.map((h) => h.field)).toEqual(["created"]);
      expect(detail.history[0]?.actorId).toBe(alice.participantId);

      const work = service.myWork(agent, {});
      expect(work.items).toHaveLength(1);
      expect(work.items[0]?.assigned).toBe(true);
      expect(work.items[0]?.mentioned).toBe(true);
    });
  });

  test("createItem rejects unknown assignees, labels, and spoofed actor fields", () => {
    withFixture(({ service, alice }) => {
      expect(() => service.createItem(alice, { title: "x", assigneeId: 999 })).toThrow(NotFoundError);
      expect(() => service.createItem(alice, { title: "x", labels: ["missing"] })).toThrow(NotFoundError);
      expect(() => service.createItem(alice, { title: "x", createdBy: 999 } as Record<string, unknown>)).toThrow(ValidationError);
      expect(() => service.createItem(alice, { title: "x", actor: "hax" } as Record<string, unknown>)).toThrow(ValidationError);
    });
  });

  test("updateItem applies only supplied fields and records diffs", () => {
    withFixture(({ service, alice, agent }) => {
      const created = service.createItem(alice, { title: "Original", body: "b", priority: 2 });
      const itemId = created.item.id;

      const first = service.updateItem(alice, itemId, { title: "Renamed", status: "doing", priority: 1 });
      expect(first.changedFields).toEqual(["title", "status", "priority"]);
      expect(first.item.title).toBe("Renamed");
      expect(first.item.body).toBe("b");
      expect(first.item.priority).toBe(1);
      expect(first.item.closedAt).toBeNull();
      expect(first.history.map((h) => h.field)).toEqual(["created", "title", "status", "priority"]);

      const done = service.updateItem(alice, itemId, { status: "done" });
      expect(done.item.closedAt).not.toBeNull();
      const reopened = service.updateItem(alice, itemId, { status: "doing" });
      expect(reopened.item.closedAt).toBeNull();

      const assigned = service.updateItem(alice, itemId, { assigneeId: agent.participantId });
      const assigneeEntry = assigned.history.find((h) => h.field === "assignee");
      expect(assigneeEntry?.oldValue).toBe("(unassigned)");
      expect(assigneeEntry?.newValue).toBe("bot");

      const unassigned = service.updateItem(alice, itemId, { assigneeId: null });
      const unassignEntry = unassigned.history.filter((h) => h.field === "assignee").pop();
      expect(unassignEntry?.newValue).toBe("(unassigned)");
    });
  });

  test("no-op update writes no history and does not churn the timestamp", () => {
    withFixture(({ service, alice }) => {
      const created = service.createItem(alice, { title: "Same" });
      const before = created.item.updatedAt;
      const historyBefore = created.history.length;

      const result = service.updateItem(alice, created.item.id, { title: "Same", priority: 2 });
      expect(result.changedFields).toEqual([]);
      expect(result.item.updatedAt).toBe(before);
      expect(result.history).toHaveLength(historyBefore);
    });
  });

  test("label replacement writes one history event per add and per remove", () => {
    withFixture(({ service, alice }) => {
      service.createLabel(alice, { name: "bug", color: "#FF0000" });
      service.createLabel(alice, { name: "docs", color: "#00FF00" });
      const created = service.createItem(alice, { title: "Labeled", labels: ["bug"] });
      const itemId = created.item.id;

      const added = service.updateItem(alice, itemId, { labels: ["bug", "docs"] });
      expect(added.changedFields).toContain("labels");
      expect(added.history.filter((h) => h.field === "label.added").map((h) => h.newValue)).toEqual(["docs"]);

      const removed = service.updateItem(alice, itemId, { labels: [] });
      expect(removed.history.filter((h) => h.field === "label.removed").map((h) => h.oldValue)).toEqual(["bug", "docs"]);
      expect(removed.item.labels).toEqual([]);
    });
  });

  test("addComment stores author, resolves mentions, and bumps activity", () => {
    withFixture(({ service, alice, agent }) => {
      const created = service.createItem(alice, { title: "Task" });
      const updatedAtBefore = created.item.updatedAt;

      const result = service.addComment(agent, created.item.id, { body: "On it. cc @alice" });
      expect(result.comment.author.id).toBe(agent.participantId);
      expect(result.comment.body).toBe("On it. cc @alice");
      expect(result.mentionedParticipants.map((p) => p.name)).toEqual(["alice"]);

      const detail = service.getItem(agent, created.item.id);
      expect(detail.comments).toHaveLength(1);
      expect(detail.item.updatedAt).not.toBe(updatedAtBefore);
      expect(detail.history).toHaveLength(1); // only "created"

      // Comment mentions surface in the mentioned participant's my_work.
      const work = service.myWork(alice, {});
      expect(work.items.map((w) => w.item.id)).toContain(created.item.id);
      expect(work.items.find((w) => w.item.id === created.item.id)?.mentioned).toBe(true);

      expect(() => service.addComment(agent, created.item.id, { body: "   " })).toThrow(ValidationError);
      expect(() => service.addComment(agent, 999, { body: "hi" })).toThrow(NotFoundError);
    });
  });

  test("deleteItem removes the item; further access is not found", () => {
    withFixture(({ service, alice }) => {
      const created = service.createItem(alice, { title: "Doomed" });
      service.deleteItem(alice, created.item.id);
      expect(() => service.getItem(alice, created.item.id)).toThrow(NotFoundError);
      expect(() => service.deleteItem(alice, created.item.id)).toThrow(NotFoundError);
      expect(() => service.updateItem(alice, created.item.id, { title: "x" })).toThrow(NotFoundError);
    });
  });

  test("listItems filters by label name, status, text, and paginates", () => {
    withFixture(({ service, alice }) => {
      service.createLabel(alice, { name: "bug", color: "#FF0000" });
      service.createItem(alice, { title: "one", labels: ["bug"] });
      service.createItem(alice, { title: "two" });
      const three = service.createItem(alice, { title: "three" });
      service.updateItem(alice, three.item.id, { status: "doing" });

      expect(service.listItems(alice, { labelName: "bug" }).items.map((i) => i.title)).toEqual(["one"]);
      expect(service.listItems(alice, { status: "doing" }).items.map((i) => i.title)).toEqual(["three"]);
      expect(service.listItems(alice, { q: "tw" }).items.map((i) => i.title)).toEqual(["two"]);

      const page1 = service.listItems(alice, { limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = service.listItems(
        alice,
        page1.nextCursor ? { limit: 2, cursor: page1.nextCursor } : { limit: 2 },
      );
      expect([...page1.items, ...page2.items].map((i) => i.title).sort()).toEqual(["one", "three", "two"]);
      expect(page2.nextCursor).toBeNull();
    });
  });
});

describe("WorkboardService participants and labels", () => {
  test("create with palette default, list, and duplicate conflicts", () => {
    withFixture(({ service, alice }) => {
      const participants = service.listParticipants(alice);
      expect(participants.map((p) => p.name)).toEqual(["alice", "bot"]);
      expect(participants.every((p) => /^#[0-9A-Fa-f]{6}$/.test(p.avatarColor))).toBe(true);

      service.createParticipant(alice, { name: "carol", kind: "human" });
      expect(() => service.createParticipant(alice, { name: "CAROL", kind: "human" })).toThrow(ConflictError);

      service.createLabel(alice, { name: "bug", color: "#FF0000" });
      expect(() => service.createLabel(alice, { name: "BUG", color: "#00FF00" })).toThrow(ConflictError);
      expect(service.listLabels(alice).map((l) => l.name)).toEqual(["bug"]);
    });
  });
});

describe("WorkboardService transactional integrity", () => {
  test("forced failure during mention insertion rolls back the whole mutation", () => {
    withFixture(({ service, alice, agent }, db) => {
      db.exec(
        "CREATE TRIGGER force_mentions_fail BEFORE INSERT ON mentions BEGIN SELECT RAISE(ABORT, 'forced failure'); END;",
      );

      expect(() => service.createItem(alice, { title: "Rollback", body: "ping @bot" })).toThrow(/forced failure/);

      const counts = (table: string): number =>
        (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(counts("items")).toBe(0);
      expect(counts("history")).toBe(0);
      expect(counts("item_labels")).toBe(0);
      expect(counts("mentions")).toBe(0);
      expect(counts("participants")).toBe(2);

      // Same guarantee for a comment with mentions.
      const item = service.createItem(alice, { title: "No mentions", body: "clean" });
      db.exec("DROP TRIGGER force_mentions_fail;");
      db.exec(
        "CREATE TRIGGER force_mentions_fail BEFORE INSERT ON mentions BEGIN SELECT RAISE(ABORT, 'forced failure'); END;",
      );
      expect(() => service.addComment(agent, item.item.id, { body: "cc @alice" })).toThrow(/forced failure/);
      expect((db.query("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n).toBe(0);
    });
  });
});

describe("WorkboardService event publication", () => {
  function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("events are published only after commit and nothing on rollback", async () => {
    const broker = new WorkboardEventBroker();
    const received: WorkboardEvent[] = [];
    withFixture(
      ({ service, alice }, db) => {
        // While delivering, the committed row must already be visible.
        broker.subscribe((event) => {
          received.push(event);
          if (event.itemId !== null) service.getItem(alice, event.itemId);
        });

        // Rolled-back mutation: no events.
        db.exec(
          "CREATE TRIGGER force_mentions_fail BEFORE INSERT ON mentions BEGIN SELECT RAISE(ABORT, 'forced failure'); END;",
        );
        expect(() => service.createItem(alice, { title: "Broken", body: "ping @bot" })).toThrow(/forced failure/);

        // Committed mutation: exactly one event, delivered after commit.
        db.exec("DROP TRIGGER force_mentions_fail;");
        service.createItem(alice, { title: "Works", body: "ping @bot" });
      },
      undefined,
      broker,
    );
    await flushMicrotasks();
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("item.created");
    expect(received[0]?.itemId).toBe(1);
  });

  test("mutation methods publish their event types", async () => {
    const broker = new WorkboardEventBroker();
    const types: string[] = [];
    withFixture(
      ({ service, alice, agent }) => {
        broker.subscribe((event) => types.push(event.type));

        service.createParticipant(alice, { name: "carol", kind: "human" });
        service.createLabel(alice, { name: "bug", color: "#FF0000" });
        const item = service.createItem(alice, { title: "T", labels: ["bug"], assigneeId: agent.participantId });
        service.updateItem(alice, item.item.id, { status: "doing" });
        service.addComment(agent, item.item.id, { body: "hi" });
        service.updateItem(alice, item.item.id, { title: "T" }); // no-op: no event
        service.deleteItem(alice, item.item.id);
      },
      undefined,
      broker,
    );
    await flushMicrotasks();
    expect(types).toEqual([
      "participant.created",
      "label.created",
      "item.created",
      "item.updated",
      "comment.created",
      "item.deleted",
    ]);
  });
});
