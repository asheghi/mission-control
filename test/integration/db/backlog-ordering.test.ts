import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initializeDatabase } from "../../../src/db/database";
import {
  createItem,
  listBacklogItems,
  listBacklogSiblingIds,
  moveItemInBacklog,
  updateItem,
} from "../../../src/db/repositories/items";
import { createParticipant } from "../../../src/db/repositories/participants";
import { ValidationError } from "../../../src/domain/errors";
import type { WorkItemType, WorkStatus } from "../../../src/domain/types";
import { withTempDataDir } from "../../helpers/temp-dir";

const now = "2026-01-01T00:00:00.000Z";

function withFixture(run: (db: Database, actorId: number) => void): void {
  withTempDataDir((dir) => {
    const db = initializeDatabase(dir);
    try {
      const actor = createParticipant(db, { name: "tester", kind: "human", avatarColor: "#112233", createdAt: now });
      run(db, actor.id);
    } finally {
      db.close();
    }
  });
}

function add(
  db: Database,
  actorId: number,
  title: string,
  parentId: number | null = null,
  workItemType: WorkItemType = parentId === null ? "user_story" : "task",
  status: WorkStatus = "todo",
): number {
  return createItem(db, {
    title,
    body: "",
    status,
    priority: 2,
    assigneeId: null,
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    parentId,
    workItemType,
  }).id;
}

describe("backlog ordering repository", () => {
  test("returns every unfinished item without the generic 100-item cap", () => {
    withFixture((db, actorId) => {
      for (let index = 0; index < 105; index += 1) add(db, actorId, `Item ${index}`);
      const done = add(db, actorId, "Done");
      updateItem(db, done, { status: "done" }, now);

      const backlog = listBacklogItems(db);
      expect(backlog).toHaveLength(105);
      expect(backlog.every((item) => item.status !== "done")).toBe(true);
      expect(backlog.map((item) => item.backlog_position)).toEqual(Array.from({ length: 105 }, (_, index) => index));
    });
  });

  test("reorders siblings and appends deterministically", () => {
    withFixture((db, actorId) => {
      const a = add(db, actorId, "A");
      const b = add(db, actorId, "B");
      const c = add(db, actorId, "C");

      db.transaction(() => moveItemInBacklog(db, { itemId: c, parentId: null, beforeId: a }))();
      expect(listBacklogSiblingIds(db, null)).toEqual([c, a, b]);

      db.transaction(() => moveItemInBacklog(db, { itemId: c, parentId: null, beforeId: null }))();
      expect(listBacklogSiblingIds(db, null)).toEqual([a, b, c]);
      expect(listBacklogItems(db).map((item) => item.backlog_position)).toEqual([0, 1, 2]);
    });
  });

  test("moves across parents and rejects invalid anchors", () => {
    withFixture((db, actorId) => {
      const firstParent = add(db, actorId, "First parent", null, "feature");
      const secondParent = add(db, actorId, "Second parent", null, "feature");
      const first = add(db, actorId, "First", firstParent);
      const moving = add(db, actorId, "Moving", firstParent);
      const destination = add(db, actorId, "Destination", secondParent);

      const result = db.transaction(() => moveItemInBacklog(db, {
        itemId: moving,
        parentId: secondParent,
        beforeId: destination,
      }))();
      expect(result).toEqual({ itemId: moving, parentId: secondParent, backlogPosition: 0 });
      expect(listBacklogSiblingIds(db, firstParent)).toEqual([first]);
      expect(listBacklogSiblingIds(db, secondParent)).toEqual([moving, destination]);
      expect(() => db.transaction(() => moveItemInBacklog(db, {
        itemId: moving,
        parentId: secondParent,
        beforeId: first,
      }))()).toThrow(ValidationError);
    });
  });
});
