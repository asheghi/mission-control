import { describe, expect, test } from "bun:test";
import { backlogItemsFromResponse, groupBacklog } from "../../../src/web/features/backlog";

function wire(id: number, parentId: number | null = null, priority = 2) {
  return { id, title: `Item ${id}`, status: "todo", priority, parentId, assignee: null, labels: [] };
}

describe("backlog data", () => {
  test("parses a complete page atomically", () => {
    expect(backlogItemsFromResponse({ data: [wire(1), wire(2, 1)], meta: { nextCursor: null } })?.map((item) => item.id)).toEqual([1, 2]);
    expect(backlogItemsFromResponse({ data: [wire(1), { ...wire(2), parentId: "bad" }], meta: { nextCursor: null } })).toBeNull();
    expect(backlogItemsFromResponse({ data: [wire(1), wire(1)], meta: { nextCursor: null } })).toBeNull();
  });

  test("groups children and keeps orphans visible", () => {
    const items = backlogItemsFromResponse({ data: [wire(1, null, 2), wire(2, 1, 0), wire(3, 99, 1)], meta: { nextCursor: null } })!;
    const groups = groupBacklog(items);
    expect(groups.map((group) => group.item.id)).toEqual([3, 1]);
    expect(groups.find((group) => group.item.id === 1)?.children.map((item) => item.id)).toEqual([2]);
    expect(groups.flatMap((group) => [group.item, ...group.children]).map((item) => item.id).sort()).toEqual([1, 2, 3]);
  });
});
