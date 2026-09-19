import { describe, expect, test } from "bun:test";
import { backlogItemsFromResponse, groupBacklog } from "../../../src/web/features/backlog";
import type { BacklogGroup } from "../../../src/web/features/backlog/types";

function wire(id: number, parentId: number | null = null, priority = 2) {
  return { id, title: `Item ${id}`, status: "todo", priority, parentId, assignee: null, labels: [] };
}

/** Flatten the tree back into `[id, level]` pairs so nesting is assertable. */
function outline(nodes: readonly BacklogGroup[], level = 1): Array<[number, number]> {
  const rows: Array<[number, number]> = [];
  for (const node of nodes) {
    rows.push([node.item.id, level]);
    rows.push(...outline(node.children, level + 1));
  }
  return rows;
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
    expect(groups.find((group) => group.item.id === 1)?.children.map((child) => child.item.id)).toEqual([2]);
    expect(groups.flatMap((group) => [group.item, ...group.children.map((child) => child.item)]).map((item) => item.id).sort()).toEqual([1, 2, 3]);
  });

  test("nests grandchildren under their own parent", () => {
    const items = backlogItemsFromResponse({
      data: [wire(1, null, 2), wire(2, 1, 2), wire(3, 2, 2), wire(4, 3, 2)],
      meta: { nextCursor: null },
    })!;
    expect(outline(groupBacklog(items))).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
  });

  test("orders siblings by priority then newest id, at every depth", () => {
    const items = backlogItemsFromResponse({
      data: [wire(1, null, 1), wire(2, 1, 3), wire(3, 1, 0), wire(4, 1, 0), wire(5, null, 0)],
      meta: { nextCursor: null },
    })!;
    expect(outline(groupBacklog(items))).toEqual([[5, 1], [1, 1], [4, 2], [3, 2], [2, 2]]);
  });

  test("a cycle is promoted to a root instead of vanishing", () => {
    // Malformed parent links (A -> B -> A) must not drop items from the tree and
    // must not recurse forever.
    const items = backlogItemsFromResponse({ data: [wire(1, 2), wire(2, 1)], meta: { nextCursor: null } })!;
    const flat = outline(groupBacklog(items));
    expect(flat.map(([id]) => id).sort()).toEqual([1, 2]);
  });

  test("an item that is its own parent becomes a root", () => {
    const items = backlogItemsFromResponse({ data: [wire(1, 1)], meta: { nextCursor: null } })!;
    expect(outline(groupBacklog(items))).toEqual([[1, 1]]);
  });

  test("a parent outside the loaded set leaves the child a root", () => {
    const items = backlogItemsFromResponse({ data: [wire(7, 404, 2)], meta: { nextCursor: null } })!;
    expect(outline(groupBacklog(items))).toEqual([[7, 1]]);
  });

  test("an empty backlog is an empty tree", () => {
    expect(groupBacklog([])).toEqual([]);
  });
});
