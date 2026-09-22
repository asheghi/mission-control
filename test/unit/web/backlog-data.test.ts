import { describe, expect, test } from "bun:test";
import {
  BACKLOG_DIRECTION_MARKS,
  BACKLOG_MOVE_DIRECTIONS,
  backlogDropTarget,
  backlogMoveDirectionReason,
  backlogInsertMove,
  backlogItemsFromResponse,
  backlogMoveActions,
  backlogMoveTargets,
  displayLevel,
  groupBacklog,
  isDescendantOf,
  dropRefusalMessage,
  isDroppableRow,
  rootRefusalMessage,
  typeAllowsRoot,
} from "../../../src/web/features/backlog";
import { MAX_ROW_LEVEL } from "../../../src/web/features/backlog/moves";
import type { BacklogGroup, BacklogItem, BacklogMove } from "../../../src/web/features/backlog/types";

function wire(id: number, parentId: number | null = null, position = id - 1) {
  return {
    id,
    title: `Item ${id}`,
    type: "user_story",
    status: "todo",
    priority: 2,
    parentId,
    backlogPosition: position,
    assignee: null,
    labels: [],
  };
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
    expect(backlogItemsFromResponse({ data: [wire(1), { ...wire(2), type: "UserStory" }], meta: { nextCursor: null } })).toBeNull();
    expect(backlogItemsFromResponse({ data: [wire(1), { ...wire(2), backlogPosition: -1 }], meta: { nextCursor: null } })).toBeNull();
    expect(backlogItemsFromResponse({ data: [wire(1), { ...wire(2), status: "done" }], meta: { nextCursor: null } })).toBeNull();
  });

  test("groups children and keeps orphans visible", () => {
    const items = backlogItemsFromResponse({ data: [wire(1, null, 1), wire(2, 1, 0), wire(3, 99, 0)], meta: { nextCursor: null } })!;
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

  test("orders siblings by backlog position then id, at every depth", () => {
    // The server owns backlog order; the client only re-derives the tree, so a
    // sibling collection must follow (backlogPosition, id) exactly as received.
    const items = backlogItemsFromResponse({
      data: [wire(1, null, 1), wire(2, 1, 2), wire(3, 1, 0), wire(4, 1, 1), wire(5, null, 0)],
      meta: { nextCursor: null },
    })!;
    expect(outline(groupBacklog(items))).toEqual([[5, 1], [1, 1], [3, 2], [4, 2], [2, 2]]);
  });

  test("an out-of-order payload is re-sorted by position, not by arrival", () => {
    const items = backlogItemsFromResponse({
      data: [wire(9, null, 2), wire(4, null, 0), wire(6, null, 1)],
      meta: { nextCursor: null },
    })!;
    expect(outline(groupBacklog(items))).toEqual([[4, 1], [6, 1], [9, 1]]);
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

// -----------------------------------------------------------------------------
// Ordering: the client derives every move from the same rules the server
// enforces, so the helpers below are what keeps drag, keyboard, and the
// optimistic overlay in agreement.
// -----------------------------------------------------------------------------
function backlogOf(entries: ReadonlyArray<[number, number | null, number, string?]>) {
  const items = backlogItemsFromResponse({
    data: entries.map(([id, parentId, position, type]) => ({ ...wire(id, parentId, position), type: type ?? "user_story" })),
    meta: { nextCursor: null },
  })!;
  const groups = groupBacklog(items);
  const visible = new Set(items.map((item) => item.id));
  return { items, groups, targets: backlogMoveTargets(groups, visible) };
}

/** Render order of the tree, as `[id, level]`, for asserting a move's effect. */
function outlineOf(items: readonly BacklogItem[]): Array<[number, number]> {
  return outline(groupBacklog(items));
}

async function optimisticOrder(items: readonly BacklogItem[], intent: BacklogMove): Promise<readonly BacklogItem[]> {
  const module = await import("../../../src/web/features/backlog/hooks");
  return module.optimisticOrder(items, intent) ?? items;
}

describe("backlog moves", () => {
  test("the rendered order is the tree order, children after their parent", () => {
    const { targets } = backlogOf([[1, null, 0], [2, 1, 0], [3, null, 1]]);
    expect(targets.order).toEqual([1, 2, 3]);
    expect(targets.siblingIndex.get(2)).toBe(0);
    expect(targets.parents.has(1)).toBe(true);
  });

  test("a sibling move down swaps with the next sibling", async () => {
    const { items, targets } = backlogOf([[1, null, 0], [2, null, 1], [3, null, 2]]);
    // "Down" must name the sibling *after* the next one: inserting directly
    // before the immediate follower would leave the order unchanged.
    const move = backlogInsertMove(targets, 1, null, 3)!;
    expect(move).toMatchObject({ itemId: 1, parentId: null, beforeId: 3 });
    expect(outlineOf(await optimisticOrder(items, move))).toEqual([[2, 1], [1, 1], [3, 1]]);
    // Naming the immediate follower really is a no-op.
    expect(backlogInsertMove(targets, 1, null, 2)).toBeNull();
  });

  test("every root offers the moves its position allows", () => {
    const { targets } = backlogOf([[1, null, 0], [2, null, 1], [3, null, 2]]);
    const ids = (id: number) => backlogMoveActions(targets, targets.byId.get(id)!).map((action) => action.id);
    // The first row cannot move up and has no previous sibling to nest under;
    // the last cannot move down; the middle can do all three.
    expect(ids(1)).toEqual(["down"]);
    expect(ids(2)).toEqual(["up", "down", "indent"]);
    expect(ids(3)).toEqual(["up", "indent"]);
    // Moving up and moving the row above you down are the same swap, reached
    // from either row.
    const up = backlogMoveActions(targets, targets.byId.get(2)!).find((action) => action.id === "up")!;
    const down = backlogMoveActions(targets, targets.byId.get(1)!).find((action) => action.id === "down")!;
    expect(up.move).toMatchObject({ itemId: 2, parentId: null, beforeId: 1 });
    expect(down.move).toMatchObject({ itemId: 1, parentId: null, beforeId: 3 });
  });

  test("moving to the end of a group appends with a null anchor", () => {
    const { targets } = backlogOf([[1, null, 0], [2, null, 1], [3, null, 2]]);
    expect(backlogInsertMove(targets, 1, null, null)).toMatchObject({ parentId: null, beforeId: null });
  });

  test("a move to where the item already is is not offered", () => {
    const { targets } = backlogOf([[1, null, 0], [2, null, 1]]);
    // Already first, and already immediately before 2.
    expect(backlogInsertMove(targets, 1, null, 2)).toBeNull();
    expect(backlogInsertMove(targets, 1, null, null)).not.toBeNull();
    // Already last: appending changes nothing.
    expect(backlogInsertMove(targets, 2, null, null)).toBeNull();
  });

  test("a Task is refused at the top level, by every helper", () => {
    const { targets } = backlogOf([[1, null, 0], [2, 1, 0, "task"]]);
    const task = targets.byId.get(2)!;
    expect(backlogInsertMove(targets, 2, null, null)).toBeNull();
    expect(backlogMoveActions(targets, task).some((action) => action.id === "root")).toBe(false);
    expect(typeAllowsRoot(task)).toBe(false);
    expect(rootRefusalMessage(task)).toContain("needs a parent");
    // The pointer path refuses through this one helper, so a drop and a move
    // button explain a refused Task identically instead of one of them going
    // silent — the defect that shipped once already.
    expect(dropRefusalMessage(task, null)).toBe(rootRefusalMessage(task));
    expect(dropRefusalMessage(task, null)).toContain("needs a parent");
    // A non-Task refusal is still explained rather than blank.
    const story = targets.byId.get(1)!;
    expect(dropRefusalMessage(story, 2)).toContain("Cannot move");
    // A Task nested under a parent is still fully movable inside that group.
    expect(backlogInsertMove(targets, 2, 1, null)).toBeNull();
  });

  test("a foreign or unsupported anchor is never sent to the server", () => {
    const { targets } = backlogOf([[1, null, 0], [2, null, 1], [3, 1, 0]]);
    // 3 is a child of 1, so it cannot anchor an insertion among the roots.
    expect(backlogInsertMove(targets, 2, null, 3)).toBeNull();
    // An id that is not in the backlog at all.
    expect(backlogInsertMove(targets, 2, null, 404)).toBeNull();
    // A missing parent.
    expect(backlogInsertMove(targets, 2, 404, null)).toBeNull();
    // An item cannot become its own child.
    expect(backlogInsertMove(targets, 1, 1, null)).toBeNull();
  });

  test("the keyboard actions cover every direction, and skip what cannot move", () => {
    const { targets } = backlogOf([[1, null, 0], [2, null, 1], [3, 1, 0]]);
    // 3 is the only child of 1, so it has no sibling to step past: its moves are
    // the structural ones, outdent and promote.
    const child = backlogMoveActions(targets, targets.byId.get(3)!);
    expect(child.map((action) => action.id).sort()).toEqual(["outdent", "root"]);

    // The root has one neighbour after it and no previous sibling, so stepping
    // down is all it can do.
    const root = backlogMoveActions(targets, targets.byId.get(1)!);
    expect(root.map((action) => action.id)).toEqual(["down"]);

    // A row with neighbours on both sides offers all three ordering moves.
    const three = backlogOf([[1, null, 0], [2, null, 1], [3, null, 2]]);
    const middle = backlogMoveActions(three.targets, three.targets.byId.get(2)!);
    expect(middle.map((action) => action.id).sort()).toEqual(["down", "indent", "up"]);
    // Every action carries a label naming the item it moves.
    for (const action of [...child, ...middle]) expect(action.label).toContain(`#${action.move.itemId}`);
  });

  test("outdent places the item after the parent it left", () => {
    const { items, targets } = backlogOf([[1, null, 0], [3, 1, 0], [4, null, 1]]);
    const action = backlogMoveActions(targets, targets.byId.get(3)!).find((candidate) => candidate.id === "outdent")!;
    expect(action.move).toMatchObject({ itemId: 3, parentId: null, beforeId: 1 });
    expect(outlineOf(items)).toEqual([[1, 1], [3, 2], [4, 1]]);
  });

  test("a drop nest into a row appends to that row's children", () => {
    const { targets } = backlogOf([[1, null, 0], [2, null, 1]]);
    expect(backlogDropTarget(targets, 2, 1, true)).toEqual({ parentId: 1, beforeId: null });
    // A drop on the row's upper half inserts beside it instead.
    expect(backlogDropTarget(targets, 1, 2, false)).toEqual({ parentId: null, beforeId: 2 });
  });

  test("dropping a row onto its own descendant would make a cycle, so it is refused", () => {
    const { targets } = backlogOf([[1, null, 0], [2, 1, 0], [3, 2, 0]]);
    expect(isDescendantOf(targets, 3, 1)).toBe(true);
    expect(isDescendantOf(targets, 1, 3)).toBe(false);
    expect(backlogDropTarget(targets, 1, 3, false)).toBeNull();
    expect(backlogDropTarget(targets, 1, 3, true)).toBeNull();
    // Dropping a row onto itself is never a move.
    expect(backlogDropTarget(targets, 1, 1, false)).toBeNull();
    expect(isDroppableRow(targets, 1, 1)).toBe(false);
    // 2 is a child of 1, so 1 cannot be dropped onto it either; a sibling or an
    // unrelated row is a valid destination.
    expect(isDroppableRow(targets, 1, 2)).toBe(false);
    expect(isDroppableRow(targets, 3, 1)).toBe(true);
  });

  test("indentation is capped so a deep tree stays on screen", () => {
    expect(displayLevel(1)).toBe(1);
    expect(displayLevel(9)).toBe(MAX_ROW_LEVEL);
    expect(displayLevel(0)).toBe(1);
  });

  test("a collapsed parent's children are not stepping stones", () => {
    const items = backlogItemsFromResponse({
      data: [wire(1, null, 0), wire(2, 1, 0), wire(3, 1, 1)],
      meta: { nextCursor: null },
    })!;
    const groups = groupBacklog(items);
    const collapsed = backlogMoveTargets(groups, new Set([1]));
    // 2 and 3 are hidden, so the visible order is just the parent.
    expect(collapsed.order).toEqual([1]);
    // They are still in the model, so they remain valid destinations by id.
    expect(collapsed.byId.has(2)).toBe(true);
    expect(collapsed.siblings.get(1)?.map((item) => item.id)).toEqual([2, 3]);
  });

  test("the optimistic order puts the row where the user dropped it", async () => {
    const { items } = backlogOf([[1, null, 0], [2, null, 1], [3, null, 2]]);
    const next = await optimisticOrder(items, { itemId: 3, parentId: null, beforeId: 1, announcement: "" });
    expect(outlineOf(next)).toEqual([[3, 1], [1, 1], [2, 1]]);
  });

  test("the optimistic order reparents as a last child", async () => {
    const { items } = backlogOf([[1, null, 0], [2, null, 1], [3, null, 2]]);
    const next = await optimisticOrder(items, { itemId: 3, parentId: 1, beforeId: null, announcement: "" });
    expect(outlineOf(next)).toEqual([[1, 1], [3, 2], [2, 1]]);
  });

  test("the optimistic order closes the gap an item left behind", async () => {
    const { items } = backlogOf([[1, null, 0], [2, 1, 0], [3, 1, 1], [4, null, 1]]);
    const next = await optimisticOrder(items, { itemId: 2, parentId: null, beforeId: 4, announcement: "" });
    // 2 leaves 1's children; 3 must close up to position 0 so the group has no
    // stale gap the server would not have written.
    expect(outlineOf(next)).toEqual([[1, 1], [3, 2], [2, 1], [4, 1]]);
    expect(next.find((item) => item.id === 3)?.backlogPosition).toBe(0);
  });

  test("an item that is not in the list makes no optimistic claim", async () => {
    const { items } = backlogOf([[1, null, 0]]);
    const module = await import("../../../src/web/features/backlog/hooks");
    expect(module.optimisticOrder(items, { itemId: 404, parentId: null, beforeId: null, announcement: "" })).toBeNull();
    expect(module.optimisticOrder(items, { itemId: 1, parentId: null, beforeId: 404, announcement: "" })).toBeNull();
  });
});

describe("Task top-level refusal is explained, never silent", () => {
  test("a Task dropped on a top-level row yields a refusal message", () => {
    const { targets } = backlogOf([[1, null, 0], [3, null, 1, "feature"], [4, 1, 0, "task"]]);
    const task = targets.byId.get(4)!;

    // Dropping the Task onto row #3's upper half resolves to "top level, before #3".
    const drop = backlogDropTarget(targets, 4, 3, false);
    expect(drop).toEqual({ parentId: null, beforeId: 3 });

    // The whole reported defect: no keyboard action describes this drop, so the
    // pointer path is the only one that can explain it - and it must.
    const keyboard = backlogMoveActions(targets, task)
      .some((action) => action.move.parentId === drop!.parentId && action.move.beforeId === drop!.beforeId);
    expect(keyboard).toBe(false);
    const message = dropRefusalMessage(task, drop!.parentId);
    expect(message).not.toBe("");
    expect(message).toBe(rootRefusalMessage(task));
    expect(message).toContain("needs a parent");
  });

  test("a refusal prompt is never an empty string, for any item or destination", () => {
    const { targets } = backlogOf([[1, null, 0], [4, 1, 0, "task"], [2, null, 1, "bug"]]);
    for (const parentId of [null, 1, 2]) {
      for (const id of [1, 2, 4]) {
        expect(dropRefusalMessage(targets.byId.get(id)!, parentId).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("every row offers the same four move directions", () => {
  test("an unavailable direction states a reason instead of vanishing", () => {
    const { targets } = backlogOf([[1, null, 0], [3, null, 1, "feature"], [4, 1, 0, "task"]]);
    for (const id of [1, 3, 4]) {
      const item = targets.byId.get(id)!;
      const available = new Set(backlogMoveActions(targets, item).map((action) => action.id));
      for (const direction of BACKLOG_MOVE_DIRECTIONS) {
        // Every direction is renderable for every row: either it has an action,
        // or it has a reason. It is never simply missing.
        const legal = available.has(direction);
        const reason = backlogMoveDirectionReason(targets, item, direction);
        expect(legal || reason.length > 0, `#${id} ${direction}`).toBe(true);
        expect(BACKLOG_DIRECTION_MARKS[direction].length).toBeGreaterThan(0);
      }
    }
  });

  test("the reason names the row and why the direction is refused", () => {
    const { targets } = backlogOf([[1, null, 0], [4, 1, 0, "task"]]);
    const first = targets.byId.get(1)!;
    expect(backlogMoveDirectionReason(targets, first, "up")).toContain("first item");
    expect(backlogMoveDirectionReason(targets, first, "indent")).toContain("no previous sibling");
    expect(backlogMoveDirectionReason(targets, first, "outdent")).toContain("already at the top level");
    const task = targets.byId.get(4)!;
    expect(backlogMoveDirectionReason(targets, task, "down")).toContain("last item");
  });
});
