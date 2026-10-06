import { describe, expect, test } from "bun:test";
import { reconcileItem } from "../../../src/web/features/detail/reconciliation";
import type { FieldName, FieldValue } from "../../../src/web/features/detail/reconciliation";
import type { DetailItem, DetailParticipant } from "../../../src/web/features/detail/types";

const owner: DetailParticipant = { id: 11, name: "reviewer", kind: "agent" };
const other: DetailParticipant = { id: 12, name: "admin", kind: "human" };

const item: DetailItem = {
  id: 7,
  title: "stale title",
  body: "server body",
  status: "todo",
  type: "feature",
  backlogPosition: 3,
  priority: 1,
  assignee: other,
  createdAt: "2024-05-01T10:00:00.000Z",
  updatedAt: "2024-05-02T11:30:00.000Z",
  closedAt: null,
  parentId: null,
  labels: [],
};

describe("quick-field reconciliation", () => {
  test("a stale response preserves newer status and assignee intent only", () => {
    const reconciled = reconcileItem(item, new Map<FieldName, FieldValue>([
      ["status", "doing"],
      ["assigneeId", owner.id],
    ]), [owner, other]);

    expect(reconciled.status).toBe("doing");
    expect(reconciled.assignee).toBe(owner);
    // Fields without pending intent continue to come from the server payload.
    expect(reconciled.title).toBe("stale title");
    expect(reconciled.body).toBe("server body");
    expect(reconciled.type).toBe("feature");
    expect(reconciled.priority).toBe(1);
    expect(reconciled.labels).toEqual([]);
  });

  test("an explicit unassign intent is distinct from no pending intent", () => {
    const reconciled = reconcileItem(item, new Map([["assigneeId", null]]), [owner, other]);
    expect(reconciled.assignee).toBeNull();
    expect(reconciled.status).toBe("todo");
  });
});
