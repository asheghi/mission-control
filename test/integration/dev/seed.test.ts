// Database seeding for development.
//
// The seeder writes through WorkboardService, so these tests assert the
// properties a developer (and the web UI) actually depends on: a board that
// is valid by the same rules every other write path obeys, with enough shape —
// hierarchy, every status, every type, labels, comments, relationships — that
// no view renders an empty state that the real product would never show.
//
// The dataset itself is asserted as data (every label, assignee, creator, and
// relationship target it names exists), so a typo in `seed-data.ts` fails here
// rather than as a half-populated development board.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { initializeDatabase } from "../../../src/db/database";
import { WorkboardService } from "../../../src/app/workboard";
import { LOCAL_ACTOR_BOOTSTRAP } from "../../../src/app/local-actor";
import { ConflictError } from "../../../src/domain/errors";
import { WORK_ITEM_TYPES, WORK_STATUSES } from "../../../src/domain/types";
import { SEED_DATASET, SEED_ITEMS, SEED_LABELS, SEED_PARTICIPANTS, SEED_RELATIONSHIPS } from "../../../src/dev/seed-data";
import type { SeedItem } from "../../../src/dev/seed-data";
import { clearWorkItems, countItems, seedBoard } from "../../../src/dev/seed";

function withSeededDatabase<T>(fn: (db: Database, service: WorkboardService) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "workboard-seed-"));
  const db = initializeDatabase(dir);
  try {
    return fn(db, new WorkboardService(db));
  } finally {
    // Closed before the directory is removed: deleting a WAL-backed database
    // under an open connection corrupts the view of it.
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every dataset key, in the order a walk of the tree encounters them. */
function datasetKeys(items: readonly SeedItem[] = SEED_ITEMS, parent: string | null = null): { key: string; parent: string | null }[] {
  return items.flatMap((item) => [{ key: item.key, parent }, ...datasetKeys(item.children ?? [], item.key)]);
}

function datasetCount(items: readonly SeedItem[] = SEED_ITEMS): number {
  return items.reduce((total, item) => total + 1 + datasetCount(item.children ?? []), 0);
}

describe("seed dataset", () => {
  test("every key is unique, and every relationship target exists", () => {
    const keys = datasetKeys().map((entry) => entry.key);
    expect(new Set(keys).size, "duplicate seed key").toBe(keys.length);

    const participantNames = new Set(SEED_PARTICIPANTS.map((participant) => participant.name));
    const labelNames = new Set(SEED_LABELS.map((label) => label.name));
    for (const relationship of SEED_RELATIONSHIPS) {
      expect(keys, `relationship source ${relationship.from}`).toContain(relationship.from);
      expect(keys, `relationship target ${relationship.to}`).toContain(relationship.to);
      expect(relationship.from, "a relationship cannot link an item to itself").not.toBe(relationship.to);
    }

    const walk = (items: readonly SeedItem[]): void => {
      for (const item of items) {
        if (item.assignee !== undefined) {
          expect(participantNames, `assignee of ${item.key}`).toContain(item.assignee);
        }
        if (item.creator !== undefined) {
          expect(participantNames, `creator of ${item.key}`).toContain(item.creator);
        }
        for (const label of item.labels ?? []) {
          expect(labelNames, `label of ${item.key}`).toContain(label);
        }
        for (const comment of item.comments ?? []) {
          expect(participantNames, `comment author on ${item.key}`).toContain(comment.author);
        }
        if (item.status !== undefined) {
          expect(WORK_STATUSES, `status of ${item.key}`).toContain(item.status);
        }
        if (item.type !== undefined) {
          expect(WORK_ITEM_TYPES, `type of ${item.key}`).toContain(item.type);
        }
        walk(item.children ?? []);
      }
    };
    walk(SEED_ITEMS);
  });

  test("is large enough to exercise pagination and every status and type", () => {
    // The list view pages at 25 and the board has four columns, so a dataset
    // that fits on one page would leave both untested by a seeded board.
    expect(datasetCount()).toBeGreaterThan(50);

    const statuses = new Set<string>();
    const types = new Set<string>();
    const walk = (items: readonly SeedItem[]): void => {
      for (const item of items) {
        statuses.add(item.status ?? "todo");
        types.add(item.type ?? (datasetKeys().find((entry) => entry.key === item.key)?.parent === null ? "user_story" : "task"));
        walk(item.children ?? []);
      }
    };
    walk(SEED_ITEMS);
    // Every status and every type must be visible somewhere on a seeded board.
    for (const status of WORK_STATUSES) expect([...statuses], `status ${status}`).toContain(status);
    for (const type of WORK_ITEM_TYPES) expect([...types], `type ${type}`).toContain(type);
  });

  test("hands out distinct avatar colours and valid label colours", () => {
    const colors = new Set(SEED_PARTICIPANTS.map((participant) => participant.avatarColor));
    expect(colors.size, "two seeded participants share an avatar colour").toBe(SEED_PARTICIPANTS.length);
    for (const participant of SEED_PARTICIPANTS) {
      expect(participant.avatarColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    for (const label of [...SEED_LABELS]) {
      expect(label.color, label.name).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    // Both agents and humans take part: a board of one kind cannot show the
    // agent badge, the mention list, or the assignee filter working.
    expect(SEED_PARTICIPANTS.filter((participant) => participant.kind === "human").length).toBeGreaterThan(0);
    expect(SEED_PARTICIPANTS.filter((participant) => participant.kind === "agent").length).toBeGreaterThan(0);
  });
});

describe("seedBoard", () => {
  test("fills an empty board through the service layer", () => {
    withSeededDatabase((db, service) => {
      const summary = seedBoard(db);

      expect(summary.reset).toBe(false);
      expect(summary.totalItems).toBe(datasetCount());
      expect(summary.items).toBe(datasetCount());
      expect(summary.participants).toBe(SEED_PARTICIPANTS.length);
      expect(summary.labels).toBe(SEED_LABELS.length);
      expect(summary.relationships).toBe(SEED_RELATIONSHIPS.length);
      expect(Object.keys(summary.itemIds).length).toBe(datasetCount());
      expect(countItems(db)).toBe(datasetCount());

      // Everything the service reports agrees with the raw table, so the seed
      // did not write around it. (The list caps at 100, which the dataset's own
      // size test already covers.)
      expect(service.listItems(LOCAL_ACTOR_BOOTSTRAP, { limit: 100 }).items.length).toBe(datasetCount());
      expect(service.listBacklog(LOCAL_ACTOR_BOOTSTRAP).length).toBeGreaterThan(0);
      expect(service.listLabels(LOCAL_ACTOR_BOOTSTRAP).map((label) => label.name).sort()).toEqual(
        [...SEED_LABELS.map((label) => label.name)].sort(),
      );
      // The roster is returned by name, so compare the sets rather than the
      // order the dataset happens to declare.
      expect(service.listParticipants(LOCAL_ACTOR_BOOTSTRAP).map((participant) => participant.name).sort()).toEqual(
        SEED_PARTICIPANTS.map((participant) => participant.name).sort(),
      );
    });
  });

  test("reproduces the dataset's hierarchy, statuses, and attribution", () => {
    withSeededDatabase((db, service) => {
      const summary = seedBoard(db);

      for (const { key, parent } of datasetKeys()) {
        const detail = service.getItem(LOCAL_ACTOR_BOOTSTRAP, summary.itemIds[key]!);
        expect(detail.item.title.length, key).toBeGreaterThan(0);
        if (parent === null) {
          expect(detail.item.parentId, `${key} should be top level`).toBeNull();
        } else {
          expect(detail.item.parentId, `${key} should sit under ${parent}`).toBe(summary.itemIds[parent]!);
        }
        // A task always has a parent: the service refuses otherwise, so a
        // seeded task at the top level would have thrown during the seed.
        if (detail.item.type === "task") {
          expect(detail.item.parentId, `task ${key} has no parent`).not.toBeNull();
        }
        expect(detail.history.some((entry) => entry.field === "created"), key).toBe(true);
      }

      const byKey = new Map(datasetKeys().map(({ key }) => [key, summary.itemIds[key]!]));
      for (const item of flatten(SEED_ITEMS)) {
        const detail = service.getItem(LOCAL_ACTOR_BOOTSTRAP, byKey.get(item.key)!);
        const expectedStatus = item.status ?? "todo";
        expect(detail.item.status, item.key).toBe(expectedStatus);
        expect(detail.item.priority, item.key).toBe(item.priority ?? 2);
        expect(detail.item.assignee?.name ?? null, item.key).toBe(item.assignee ?? null);
        expect(detail.item.labels.map((label) => label.name).sort(), item.key).toEqual([...(item.labels ?? [])].sort());
        expect(detail.comments.length, item.key).toBe((item.comments ?? []).length);
        // A done item is closed; an open one is not. This is the invariant the
        // board's date column and the `closed_at` sort both rely on.
        if (expectedStatus === "done") {
          expect(detail.item.closedAt, `${item.key} is done but not closed`).not.toBeNull();
        } else {
          expect(detail.item.closedAt, `${item.key} is open but closed`).toBeNull();
        }
        if ((item.comments ?? []).length > 0) {
          expect(detail.history.some((entry) => entry.field === "created"), item.key).toBe(true);
        }
      }
    });
  });

  test("writes the relationships the dataset declares, in both directions", () => {
    withSeededDatabase((db, service) => {
      const summary = seedBoard(db);
      for (const relationship of SEED_RELATIONSHIPS) {
        const from = service.getItem(LOCAL_ACTOR_BOOTSTRAP, summary.itemIds[relationship.from]!);
        const mirrorName = inverse(relationship.name);
        const seen = [
          ...from.related,
          ...from.predecessors,
          ...from.successors,
          ...from.duplicates,
          ...(from.duplicateOf === null ? [] : [from.duplicateOf]),
        ];
        const targetId = summary.itemIds[relationship.to]!;
        expect(
          seen.some((entry) => entry.name === relationship.name && entry.item.id === targetId),
          `${relationship.from} should see ${relationship.name} → ${relationship.to}`,
        ).toBe(true);

        // A link is stored once and read from both sides, so the mirror must
        // exist too — otherwise one of the two detail pages lies.
        const to = service.getItem(LOCAL_ACTOR_BOOTSTRAP, targetId);
        const mirror = [
          ...to.related,
          ...to.predecessors,
          ...to.successors,
          ...to.duplicates,
          ...(to.duplicateOf === null ? [] : [to.duplicateOf]),
        ];
        expect(
          mirror.some((entry) => entry.name === mirrorName && entry.item.id === from.item.id),
          `${relationship.to} should see ${mirrorName} → ${relationship.from}`,
        ).toBe(true);
      }
    });
  });

  test("records @mentions on seeded comments", () => {
    withSeededDatabase((db, service) => {
      const summary = seedBoard(db);
      const mentioned = service.getItem(LOCAL_ACTOR_BOOTSTRAP, summary.itemIds["backlog-view"]!);
      expect(mentioned.comments).toHaveLength(2);
      expect(mentioned.comments[0]?.body).toContain("@codex");
      // The mention has to reach the mentioned agent's my_work, or the seeded
      // conversation would look alive in the UI and dead in the agent's queue.
      const codex = service.listParticipants(LOCAL_ACTOR_BOOTSTRAP).find((participant) => participant.name === "codex");
      expect(codex).toBeDefined();
      const work = service.myWork({ participantId: codex!.id, name: "codex", kind: "agent" }, { limit: 100 });
      expect(work.items.some((entry) => entry.item.id === summary.itemIds["backlog-view"] && entry.mentioned)).toBe(true);
    });
  });

  test("refuses a board that already has work, and says what to do", () => {
    withSeededDatabase((db) => {
      seedBoard(db);
      expect(() => seedBoard(db)).toThrow(ConflictError);
      // The refusal must not have touched anything.
      expect(countItems(db)).toBe(datasetCount());
    });
  });

  test("--reset replaces the work items but keeps people, labels, and tokens", () => {
    withSeededDatabase((db, service) => {
      const first = seedBoard(db);
      const participantsBefore = service.listParticipants(LOCAL_ACTOR_BOOTSTRAP);
      const labelsBefore = service.listLabels(LOCAL_ACTOR_BOOTSTRAP);

      // A hand-made item stands in for real work that must not survive.
      const author = participantsBefore[0]!;
      service.createItem({ participantId: author.id, name: author.name, kind: author.kind }, { title: "Written by a human" });
      expect(countItems(db)).toBe(datasetCount() + 1);

      const second = seedBoard(db, { reset: true });
      expect(second.reset).toBe(true);
      expect(countItems(db)).toBe(datasetCount());
      // Participants and labels are reused, not duplicated, so a reset cannot
      // quietly sign everyone out or fork a label.
      expect(second.participants).toBe(0);
      expect(second.labels).toBe(0);
      expect(service.listParticipants(LOCAL_ACTOR_BOOTSTRAP)).toEqual(participantsBefore);
      expect(service.listLabels(LOCAL_ACTOR_BOOTSTRAP)).toEqual(labelsBefore);
      expect(service.listItems(LOCAL_ACTOR_BOOTSTRAP, { q: "Written by a human" }).items).toHaveLength(0);

      // And the replacement is the same board, not a reshuffle: identical keys
      // resolve to identical ids because nothing else claimed them.
      expect(second.itemIds).toEqual(first.itemIds);
    });
  });

  test("clearWorkItems empties the graph and leaves the people behind", () => {
    withSeededDatabase((db, service) => {
      seedBoard(db);
      const participants = service.listParticipants(LOCAL_ACTOR_BOOTSTRAP);
      const labels = service.listLabels(LOCAL_ACTOR_BOOTSTRAP);

      clearWorkItems(db);

      expect(countItems(db)).toBe(0);
      for (const table of ["comments", "history", "mentions", "item_labels", "item_links"]) {
        const row = db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
        expect(row.n, `${table} still has rows`).toBe(0);
      }
      expect(service.listParticipants(LOCAL_ACTOR_BOOTSTRAP)).toEqual(participants);
      expect(service.listLabels(LOCAL_ACTOR_BOOTSTRAP)).toEqual(labels);
    });
  });

  test("is deterministic: the same dataset always yields the same board", () => {
    const shape = (): string => {
      return withSeededDatabase((db, service) => {
        const summary = seedBoard(db);
        // Sorted here rather than relying on the API's order: `listItems` sorts
        // by `updated_at DESC`, and two rows written in the same millisecond tie,
        // so the API's sequence legitimately varies between two identical
        // seeds. The board's *content* must not.
        const rows = service
          .listItems(LOCAL_ACTOR_BOOTSTRAP, { limit: 100 })
          .items.map((item) => `${item.parentId ?? "-"}:${item.type}:${item.status}:${item.priority}:${item.title}`)
          .sort()
          .join("|");
        return `${Object.entries(summary.itemIds).map(([key, id]) => `${key}=${id}`).join(",")}::${rows}`;
      });
    };
    expect(shape()).toBe(shape());
  });

  test("an overridden dataset seeds exactly itself", () => {
    const dataset = {
      participants: [{ name: "zoe", kind: "agent" as const, avatarColor: "#111111" }],
      labels: [{ name: "solo", color: "#222222" }],
      items: [
        {
          key: "only",
          title: "The only item",
          type: "user_story" as const,
          status: "doing" as const,
          labels: ["solo"],
        },
      ],
      relationships: [],
    };
    withSeededDatabase((db, service) => {
      const summary = seedBoard(db, { dataset });
      expect(summary.items).toBe(1);
      expect(summary.totalItems).toBe(1);
      expect(service.listParticipants(LOCAL_ACTOR_BOOTSTRAP).map((p) => p.name)).toEqual(["zoe"]);
      const item = service.getItem(LOCAL_ACTOR_BOOTSTRAP, summary.itemIds["only"]!);
      expect(item.item.title).toBe("The only item");
      expect(item.item.status).toBe("doing");
      expect(item.item.labels.map((label) => label.name)).toEqual(["solo"]);
      // No leftover from a previous dataset on the same board.
      expect(service.listLabels(LOCAL_ACTOR_BOOTSTRAP).map((label) => label.name)).toEqual(["solo"]);
    });
  });

  test("refuses a dataset that names something it does not define", () => {
    const broken = {
      participants: [{ name: "zoe", kind: "agent" as const, avatarColor: "#111111" }],
      labels: [],
      items: [
        {
          key: "only",
          title: "Assigned to nobody",
          assignee: "ghost",
        },
      ],
      relationships: [],
    };
    withSeededDatabase((db) => {
      expect(() => seedBoard(db, { dataset: broken })).toThrow(/unknown participant: ghost/);
    });
  });
});

function flatten(items: readonly SeedItem[]): SeedItem[] {
  return items.flatMap((item) => [item, ...flatten(item.children ?? [])]);
}

function inverse(name: string): string {
  switch (name) {
    case "predecessor": return "successor";
    case "successor": return "predecessor";
    case "duplicate": return "duplicate_of";
    case "duplicate_of": return "duplicate";
    default: return "related";
  }
}
