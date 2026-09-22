import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initializeDatabase } from "../../../src/db/database";
import {
  createItemLink,
  deleteItemLink,
  isDependencyReachable,
  listItemLinks,
} from "../../../src/db/repositories/item-links";
import { createItem } from "../../../src/db/repositories/items";
import { createParticipant } from "../../../src/db/repositories/participants";
import { ConflictError, ValidationError } from "../../../src/domain/errors";
import { withTempDataDir } from "../../helpers/temp-dir";

function withFixture(run: (db: Database, actorId: number, ids: number[]) => void): void {
  withTempDataDir((dir) => {
    const db = initializeDatabase(dir);
    try {
      const actor = createParticipant(db, {
        name: "tester",
        kind: "human",
        avatarColor: "#112233",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const ids = Array.from({ length: 4 }, (_, index) => createItem(db, {
        title: `Item ${index + 1}`,
        body: "",
        status: "todo",
        priority: 2,
        assigneeId: null,
        createdBy: actor.id,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        closedAt: null,
        parentId: null,
        workItemType: "user_story",
      }).id);
      run(db, actor.id, ids);
    } finally {
      db.close();
    }
  });
}

const now = "2026-01-01T00:00:00.000Z";

describe("item links repository", () => {
  test("normalizes symmetric related links and rejects duplicates and self-links", () => {
    withFixture((db, actorId, [a, b]) => {
      const link = createItemLink(db, { kind: "related", sourceItemId: b!, targetItemId: a!, createdBy: actorId, createdAt: now });
      expect([link.source_item_id, link.target_item_id]).toEqual([a!, b!]);
      expect(listItemLinks(db, a!)).toHaveLength(1);
      expect(listItemLinks(db, b!)).toHaveLength(1);
      expect(() => createItemLink(db, { kind: "related", sourceItemId: a!, targetItemId: b!, createdBy: actorId, createdAt: now })).toThrow(ConflictError);
      expect(() => createItemLink(db, { kind: "related", sourceItemId: a!, targetItemId: a!, createdBy: actorId, createdAt: now })).toThrow(ValidationError);
    });
  });

  test("stores directed dependencies and prevents cycles", () => {
    withFixture((db, actorId, [a, b, c]) => {
      createItemLink(db, { kind: "dependency", sourceItemId: a!, targetItemId: b!, createdBy: actorId, createdAt: now });
      createItemLink(db, { kind: "dependency", sourceItemId: b!, targetItemId: c!, createdBy: actorId, createdAt: now });
      expect(isDependencyReachable(db, a!, c!)).toBe(true);
      expect(isDependencyReachable(db, c!, a!)).toBe(false);
      expect(() => createItemLink(db, { kind: "dependency", sourceItemId: c!, targetItemId: a!, createdBy: actorId, createdAt: now })).toThrow(ConflictError);
    });
  });

  test("allows one duplicate target and cascades or explicitly deletes links", () => {
    withFixture((db, actorId, [a, b, c]) => {
      const duplicate = createItemLink(db, { kind: "duplicate", sourceItemId: a!, targetItemId: b!, createdBy: actorId, createdAt: now });
      expect(() => createItemLink(db, { kind: "duplicate", sourceItemId: a!, targetItemId: c!, createdBy: actorId, createdAt: now })).toThrow(ConflictError);
      expect(deleteItemLink(db, duplicate.id)).toBe(true);
      expect(listItemLinks(db, a!)).toEqual([]);

      createItemLink(db, { kind: "related", sourceItemId: a!, targetItemId: b!, createdBy: actorId, createdAt: now });
      db.query("DELETE FROM items WHERE id = ?").run(a!);
      expect(listItemLinks(db, b!)).toEqual([]);
    });
  });
});
