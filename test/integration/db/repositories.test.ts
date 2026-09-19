import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initializeDatabase } from "../../../src/db/database";
import { createComment, listComments } from "../../../src/db/repositories/comments";
import { appendHistory, listHistory } from "../../../src/db/repositories/history";
import {
  createItem,
  deleteItem,
  getItemById,
  getItemJoined,
  listItems,
  myWork,
  updateItem,
} from "../../../src/db/repositories/items";
import {
  createLabel,
  getLabelByName,
  labelsForItems,
  listLabels,
  listLabelsForItem,
  setItemLabels,
} from "../../../src/db/repositories/labels";
import { listMentionsForItem, listMentionedParticipantIds, replaceCommentMentions, replaceItemMentions } from "../../../src/db/repositories/mentions";
import { createParticipant, getParticipantById, getParticipantByName, listParticipants } from "../../../src/db/repositories/participants";
import { createToken, findTokenByDigest, revokeToken, touchToken } from "../../../src/db/repositories/tokens";
import type { Priority, WorkStatus } from "../../../src/domain/types";
import { withTempDataDir } from "../../helpers/temp-dir";

function makeParticipant(db: Database, name: string, kind: "human" | "agent" = "human") {
  return createParticipant(db, { name, kind, avatarColor: "#101010", createdAt: "2026-01-01T00:00:00.000Z" });
}

function makeItem(
  db: Database,
  creatorId: number,
  overrides: {
    readonly title?: string;
    readonly body?: string;
    readonly status?: WorkStatus;
    readonly priority?: Priority;
    readonly assigneeId?: number | null;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly closedAt?: string | null;
    readonly parentId?: number | null;
  } = {},
) {
  return createItem(db, {
    title: overrides.title ?? "Item",
    body: overrides.body ?? "",
    status: overrides.status ?? "todo",
    priority: overrides.priority ?? 2,
    assigneeId: overrides.assigneeId ?? null,
    createdBy: creatorId,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    closedAt: overrides.closedAt ?? null,
    parentId: overrides.parentId ?? null,
  });
}

describe("participant repository", () => {
  test("create, get by id, get by name (case-insensitive), list", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const alice = makeParticipant(db, "Alice", "human");
        expect(alice.name).toBe("Alice");
        expect(alice.kind).toBe("human");

        expect(getParticipantById(db, alice.id)?.name).toBe("Alice");
        expect(getParticipantById(db, 9999)).toBeNull();

        // Names are COLLATE NOCASE: lookup is case-insensitive.
        expect(getParticipantByName(db, "alice")?.id).toBe(alice.id);
        expect(getParticipantByName(db, "ALICE")?.id).toBe(alice.id);
        expect(getParticipantByName(db, "nobody")).toBeNull();

        // Duplicate names conflict regardless of case.
        expect(() => makeParticipant(db, "ALICE")).toThrow(/UNIQUE/);

        const agent = makeParticipant(db, "bob-agent", "agent");
        const names = listParticipants(db).map((p) => p.name);
        expect(names).toEqual(["Alice", "bob-agent"]);
        expect(agent.kind).toBe("agent");
      } finally {
        db.close();
      }
    });
  });
});

describe("label repository", () => {
  test("create, get, list, item assignment, batch lookup", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const human = makeParticipant(db, "alice");
        const bug = createLabel(db, { name: "bug", color: "#FF0000", createdAt: "2026-01-01T00:00:00.000Z" });
        const docs = createLabel(db, { name: "docs", color: "#00FF00", createdAt: "2026-01-01T00:00:00.000Z" });

        expect(getLabelByName(db, "BUG")?.id).toBe(bug.id);
        expect(getLabelByName(db, "missing")).toBeNull();
        expect(listLabels(db).map((l) => l.name)).toEqual(["bug", "docs"]);

        const item = makeItem(db, human.id, { title: "labeled" });
        setItemLabels(db, item.id, [bug.id, docs.id]);
        expect(listLabelsForItem(db, item.id).map((l) => l.name)).toEqual(["bug", "docs"]);

        const batch = labelsForItems(db, [item.id]);
        expect(batch.get(item.id)?.map((l) => l.name)).toEqual(["bug", "docs"]);
        expect(labelsForItems(db, []).size).toBe(0);

        // Replacing keeps exactly the new set.
        setItemLabels(db, item.id, [docs.id]);
        expect(listLabelsForItem(db, item.id).map((l) => l.name)).toEqual(["docs"]);
      } finally {
        db.close();
      }
    });
  });
});

describe("token repository", () => {
  test("create, find by digest, touch, revoke", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const human = makeParticipant(db, "alice");
        const token = createToken(db, {
          participantId: human.id,
          name: "bootstrap",
          tokenPrefix: "wb_abc12",
          secretDigest: "digest-1",
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        expect(token.token_prefix).toBe("wb_abc12");

        expect(findTokenByDigest(db, "digest-1")?.id).toBe(token.id);
        expect(findTokenByDigest(db, "unknown")).toBeNull();

        touchToken(db, token.id, "2026-01-02T00:00:00.000Z");
        expect(findTokenByDigest(db, "digest-1")?.last_used_at).toBe("2026-01-02T00:00:00.000Z");

        expect(revokeToken(db, token.id, "2026-01-03T00:00:00.000Z")).toBe(true);
        const revoked = findTokenByDigest(db, "digest-1");
        expect(revoked?.revoked_at).toBe("2026-01-03T00:00:00.000Z");
        // Revoking twice changes nothing.
        expect(revokeToken(db, token.id, "2026-01-04T00:00:00.000Z")).toBe(false);
        expect(revoked?.revoked_at).toBe("2026-01-03T00:00:00.000Z");
      } finally {
        db.close();
      }
    });
  });
});

describe("item repository", () => {
  test("create, get, joined get with assignee and comment count", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const human = makeParticipant(db, "alice");
        const agent = makeParticipant(db, "bot", "agent");
        const item = makeItem(db, human.id, { title: "T1", body: "B1", assigneeId: agent.id, priority: 3 });

        const plain = getItemById(db, item.id);
        expect(plain?.title).toBe("T1");
        expect(getItemById(db, 9999)).toBeNull();

        const joined = getItemJoined(db, item.id);
        expect(joined?.assignee_name).toBe("bot");
        expect(joined?.assignee_kind).toBe("agent");
        expect(joined?.comment_count).toBe(0);

        createComment(db, { itemId: item.id, authorId: human.id, body: "hello", createdAt: "2026-01-01T00:00:01.000Z" });
        expect(getItemJoined(db, item.id)?.comment_count).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  test("list filters: status, assignee, unassigned, label, text search", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const human = makeParticipant(db, "alice");
        const agent = makeParticipant(db, "bot", "agent");
        const bug = createLabel(db, { name: "bug", color: "#FF0000", createdAt: "2026-01-01T00:00:00.000Z" });

        const todoAssigned = makeItem(db, human.id, { title: "fix crash", updatedAt: "2026-01-01T00:00:01.000Z", assigneeId: agent.id });
        const todoUnassigned = makeItem(db, human.id, { title: "write docs", updatedAt: "2026-01-01T00:00:02.000Z" });
        const doneBug = makeItem(db, human.id, { title: "old bug", status: "done", updatedAt: "2026-01-01T00:00:03.000Z", closedAt: "2026-01-01T00:00:03.000Z" });
        setItemLabels(db, doneBug.id, [bug.id]);

        const all = listItems(db, { limit: 10 }).items;
        expect(all.map((i) => i.id)).toEqual([doneBug.id, todoUnassigned.id, todoAssigned.id]);

        expect(listItems(db, { limit: 10, statusIn: ["todo"] }).items.map((i) => i.id)).toEqual([
          todoUnassigned.id,
          todoAssigned.id,
        ]);
        expect(listItems(db, { limit: 10, assigneeId: agent.id }).items.map((i) => i.id)).toEqual([todoAssigned.id]);
        // Unassigned matches any status; doneBug (id 3) has no assignee either.
        expect(listItems(db, { limit: 10, unassigned: true }).items.map((i) => i.id)).toEqual([doneBug.id, todoUnassigned.id]);
        expect(listItems(db, { limit: 10, labelId: bug.id }).items.map((i) => i.id)).toEqual([doneBug.id]);

        expect(listItems(db, { limit: 10, q: "crash" }).items.map((i) => i.id)).toEqual([todoAssigned.id]);
        expect(listItems(db, { limit: 10, q: "%00%" }).items).toEqual([]);
        // Literal percent in the query still matches a title containing "100%".
        const pct = makeItem(db, human.id, { title: "100% done", updatedAt: "2026-01-01T00:00:04.000Z" });
        expect(listItems(db, { limit: 10, q: "0%" }).items.map((i) => i.id)).toEqual([pct.id]);
      } finally {
        db.close();
      }
    });
  });

  test("list pagination is deterministic and lossless across pages", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const human = makeParticipant(db, "alice");
        // Same updated_at for two items exercises the id tiebreak.
        makeItem(db, human.id, { title: "a", updatedAt: "2026-01-01T00:00:01.000Z" });
        makeItem(db, human.id, { title: "b", updatedAt: "2026-01-01T00:00:02.000Z" });
        makeItem(db, human.id, { title: "c", updatedAt: "2026-01-01T00:00:02.000Z" });
        makeItem(db, human.id, { title: "d", updatedAt: "2026-01-01T00:00:03.000Z" });
        makeItem(db, human.id, { title: "e", updatedAt: "2026-01-01T00:00:04.000Z" });

        const seen: number[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 10; page += 1) {
          const result = listItems(db, { limit: 2, cursor });
          seen.push(...result.items.map((i) => i.id));
          if (result.nextCursor === null) break;
          cursor = result.nextCursor;
        }
        expect(seen).toHaveLength(5);
        expect(new Set(seen).size).toBe(5);

        const full = listItems(db, { limit: 10 }).items.map((i) => i.id);
        expect(seen).toEqual(full);
      } finally {
        db.close();
      }
    });
  });

  test("update applies partial changes including unassign and clear closedAt", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const human = makeParticipant(db, "alice");
        const agent = makeParticipant(db, "bot", "agent");
        const item = makeItem(db, human.id, { assigneeId: agent.id });

        expect(updateItem(db, item.id, { title: "new", priority: 3, closedAt: "2026-01-02T00:00:00.000Z" }, "2026-01-02T00:00:00.000Z")).toBe(true);
        let row = getItemById(db, item.id);
        expect(row?.title).toBe("new");
        expect(row?.priority).toBe(3);
        expect(row?.closed_at).toBe("2026-01-02T00:00:00.000Z");
        expect(row?.updated_at).toBe("2026-01-02T00:00:00.000Z");

        expect(updateItem(db, item.id, { assigneeId: null }, "2026-01-03T00:00:00.000Z")).toBe(true);
        row = getItemById(db, item.id);
        expect(row?.assignee_id).toBeNull();
        expect(row?.title).toBe("new");

        expect(updateItem(db, 9999, { title: "x" }, "2026-01-03T00:00:00.000Z")).toBe(false);
      } finally {
        db.close();
      }
    });
  });

  test("my_work returns assigned or mentioned items deduplicated, open first", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const human = makeParticipant(db, "alice");
        const agent = makeParticipant(db, "bot", "agent");

        const assigned = makeItem(db, human.id, { title: "assigned", assigneeId: agent.id, updatedAt: "2026-01-01T00:00:01.000Z" });
        const mentioned = makeItem(db, human.id, { title: "mentioned", body: "ping @bot", updatedAt: "2026-01-01T00:00:02.000Z" });
        replaceItemMentions(db, mentioned.id, [agent.id], "2026-01-01T00:00:02.000Z");
        const both = makeItem(db, human.id, { title: "both", assigneeId: agent.id, updatedAt: "2026-01-01T00:00:03.000Z" });
        replaceItemMentions(db, both.id, [agent.id], "2026-01-01T00:00:03.000Z");
        const doneAssigned = makeItem(db, human.id, {
          title: "finished",
          assigneeId: agent.id,
          status: "done",
          closedAt: "2026-01-01T00:00:04.000Z",
          updatedAt: "2026-01-01T00:00:04.000Z",
        });
        makeItem(db, human.id, { title: "unrelated", updatedAt: "2026-01-01T00:00:05.000Z" });

        const result = myWork(db, agent.id, { limit: 10 });
        // Open first (both, mentioned, assigned by updated_at DESC), then done.
        expect(result.items.map((i) => i.id)).toEqual([both.id, mentioned.id, assigned.id, doneAssigned.id]);
        expect(result.items).toHaveLength(4); // deduplicated by item id

        const byId = new Map(result.items.map((i) => [i.id, i]));
        expect(byId.get(both.id)?.assigned).toBe(1);
        expect(byId.get(both.id)?.mentioned).toBe(1);
        expect(byId.get(mentioned.id)?.assigned).toBe(0);
        expect(byId.get(mentioned.id)?.mentioned).toBe(1);
        expect(byId.get(assigned.id)?.assigned).toBe(1);
        expect(byId.get(assigned.id)?.mentioned).toBe(0);

        expect(myWork(db, agent.id, { limit: 10, status: "done" }).items.map((i) => i.id)).toEqual([doneAssigned.id]);
        expect(myWork(db, human.id, { limit: 10 }).items.map((i) => i.id)).toEqual([]);

        // my_work pagination over the same ordering.
        const page1 = myWork(db, agent.id, { limit: 2 });
        expect(page1.items.map((i) => i.id)).toEqual([both.id, mentioned.id]);
        expect(page1.nextCursor).not.toBeNull();
        const page2 = myWork(db, agent.id, { limit: 2, cursor: page1.nextCursor });
        expect(page2.items.map((i) => i.id)).toEqual([assigned.id, doneAssigned.id]);
      } finally {
        db.close();
      }
    });
  });

  test("delete removes the item and reports idempotence", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const human = makeParticipant(db, "alice");
        const item = makeItem(db, human.id);
        expect(deleteItem(db, item.id)).toBe(true);
        expect(deleteItem(db, item.id)).toBe(false);
        expect(getItemById(db, item.id)).toBeNull();
      } finally {
        db.close();
      }
    });
  });
});

describe("comment repository", () => {
  test("create, joined list ordering, pagination", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const human = makeParticipant(db, "alice");
        const agent = makeParticipant(db, "bot", "agent");
        const item = makeItem(db, human.id);

        const c1 = createComment(db, { itemId: item.id, authorId: human.id, body: "first", createdAt: "2026-01-01T00:00:01.000Z" });
        const c2 = createComment(db, { itemId: item.id, authorId: agent.id, body: "second", createdAt: "2026-01-01T00:00:02.000Z" });
        const c3 = createComment(db, { itemId: item.id, authorId: human.id, body: "third", createdAt: "2026-01-01T00:00:02.000Z" });

        const page1 = listComments(db, item.id, { limit: 2 });
        expect(page1.comments.map((c) => c.id)).toEqual([c1.id, c2.id]);
        expect(page1.comments[0]?.author_name).toBe("alice");
        expect(page1.comments[1]?.author_kind).toBe("agent");
        expect(page1.nextCursor).not.toBeNull();

        const page2 = listComments(db, item.id, { limit: 2, cursor: page1.nextCursor });
        expect(page2.comments.map((c) => c.id)).toEqual([c3.id]);
        expect(page2.nextCursor).toBeNull();
      } finally {
        db.close();
      }
    });
  });
});

describe("mention repository", () => {
  test("replace is idempotent per source and scoped to item vs comment", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const human = makeParticipant(db, "alice");
        const agent = makeParticipant(db, "bot", "agent");
        const other = makeParticipant(db, "carol");
        const item = makeItem(db, human.id);

        replaceItemMentions(db, item.id, [agent.id, other.id], "2026-01-01T00:00:00.000Z");
        replaceItemMentions(db, item.id, [agent.id, other.id], "2026-01-01T00:00:00.000Z");
        expect(listMentionedParticipantIds(db, item.id)).toEqual([agent.id, other.id]);
        expect(listMentionsForItem(db, item.id)).toHaveLength(2);

        replaceItemMentions(db, item.id, [agent.id], "2026-01-01T00:00:01.000Z");
        expect(listMentionedParticipantIds(db, item.id)).toEqual([agent.id]);

        const comment = createComment(db, { itemId: item.id, authorId: human.id, body: "cc @carol", createdAt: "2026-01-01T00:00:02.000Z" });
        replaceCommentMentions(db, item.id, comment.id, [other.id], "2026-01-01T00:00:02.000Z");
        expect(listMentionedParticipantIds(db, item.id).sort((a, b) => a - b)).toEqual([agent.id, other.id]);
        expect(listMentionsForItem(db, item.id).filter((m) => m.comment_id === comment.id)).toHaveLength(1);
      } finally {
        db.close();
      }
    });
  });
});

describe("history repository", () => {
  test("append and ordered list with actor names", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const human = makeParticipant(db, "alice");
        const agent = makeParticipant(db, "bot", "agent");
        const item = makeItem(db, human.id);

        appendHistory(db, { itemId: item.id, actorId: human.id, field: "created", oldValue: null, newValue: null, createdAt: "2026-01-01T00:00:00.000Z" });
        appendHistory(db, { itemId: item.id, actorId: agent.id, field: "status", oldValue: "todo", newValue: "doing", createdAt: "2026-01-01T00:00:01.000Z" });

        const page = listHistory(db, item.id, { limit: 10 });
        expect(page.entries.map((h) => h.field)).toEqual(["created", "status"]);
        expect(page.entries[1]?.actor_name).toBe("bot");
        expect(page.entries[1]?.new_value).toBe("doing");
      } finally {
        db.close();
      }
    });
  });
});

describe("schema integrity", () => {
  test("required indexes exist", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name IS NOT NULL").all() as Array<{ name: string }>;
        const names = new Set(rows.map((r) => r.name));
        for (const expected of [
          "idx_items_status_updated",
          "idx_items_assignee_status",
          "idx_comments_item_time",
          "idx_mentions_participant_item",
          "idx_mentions_item_body_unique",
          "idx_mentions_comment_unique",
          "idx_labels_name",
          "idx_history_item_time",
          "idx_api_tokens_digest",
          "idx_api_tokens_prefix",
        ]) {
          expect(names.has(expected), expected).toBe(true);
        }
      } finally {
        db.close();
      }
    });
  });

  test("foreign keys reject dangling references", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        expect(() => makeItem(db, 9999)).toThrow(/FOREIGN KEY/);
        const human = makeParticipant(db, "alice");
        expect(() => makeItem(db, human.id, { assigneeId: 9999 })).toThrow(/FOREIGN KEY/);
      } finally {
        db.close();
      }
    });
  });

  test("deleting an item cascades to comments, mentions, history, and labels", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const human = makeParticipant(db, "alice");
        const agent = makeParticipant(db, "bot", "agent");
        const label = createLabel(db, { name: "bug", color: "#FF0000", createdAt: "2026-01-01T00:00:00.000Z" });
        const item = makeItem(db, human.id);
        createComment(db, { itemId: item.id, authorId: agent.id, body: "c", createdAt: "2026-01-01T00:00:00.000Z" });
        replaceItemMentions(db, item.id, [agent.id], "2026-01-01T00:00:00.000Z");
        setItemLabels(db, item.id, [label.id]);
        appendHistory(db, { itemId: item.id, actorId: human.id, field: "created", oldValue: null, newValue: null, createdAt: "2026-01-01T00:00:00.000Z" });

        deleteItem(db, item.id);
        expect(listComments(db, item.id, { limit: 10 }).comments).toHaveLength(0);
        expect(listMentionsForItem(db, item.id)).toHaveLength(0);
        expect(listHistory(db, item.id, { limit: 10 }).entries).toHaveLength(0);
        expect(listLabelsForItem(db, item.id)).toHaveLength(0);
      } finally {
        db.close();
      }
    });
  });

  test("deleting a participant nulls assignees, cascades tokens, and blocks comment authors", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const human = makeParticipant(db, "alice");
        const agent = makeParticipant(db, "bot", "agent");
        const item = makeItem(db, human.id, { assigneeId: agent.id });
        createToken(db, { participantId: agent.id, name: "t", tokenPrefix: "wb_x", secretDigest: "d1", createdAt: "2026-01-01T00:00:00.000Z" });

        db.query("DELETE FROM participants WHERE id = ?").run(agent.id);
        expect(getItemById(db, item.id)?.assignee_id).toBeNull();
        expect(findTokenByDigest(db, "d1")).toBeNull();

        createComment(db, { itemId: item.id, authorId: human.id, body: "c", createdAt: "2026-01-01T00:00:00.000Z" });
        expect(() => db.query("DELETE FROM participants WHERE id = ?").run(human.id)).toThrow(/FOREIGN KEY/);
      } finally {
        db.close();
      }
    });
  });
});
