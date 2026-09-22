import { WORK_ITEM_TYPE_LABELS } from "../../../domain/types";
import type { BacklogGroup, BacklogItem, BacklogMove, BacklogMoveAction, BacklogTargets } from "./types";

/** How far a row is indented before indentation stops growing, in levels. */
export const MAX_ROW_LEVEL = 8;

export function backlogItemLabel(item: BacklogItem): string {
  return `${WORK_ITEM_TYPE_LABELS[item.type]} #${item.id} \u201C${item.title}\u201D`;
}

/** Level a row is drawn at: the aria-level published on the row itself. */
export function backlogLevels(groups: readonly BacklogGroup[]): ReadonlyMap<number, number> {
  const levels = new Map<number, number>();
  const walk = (node: BacklogGroup, level: number): void => {
    levels.set(node.item.id, level);
    for (const child of node.children) walk(child, level + 1);
  };
  for (const group of groups) walk(group, 1);
  return levels;
}

/**
 * Flatten the rendered tree into the facts a move needs: where every item
 * currently sits, and which line of the rendered list an insertion lands on.
 *
 * `rows` is the rendered order rather than a re-sort by position, so "move
 * down" means the next line the user can actually see: a collapsed parent's
 * children stay in the model but are not candidates for a visible step.
 */
export function backlogMoveTargets(groups: readonly BacklogGroup[], visible: ReadonlySet<number>): BacklogTargets {
  const byId = new Map<number, BacklogItem>();
  const rows: BacklogItem[] = [];
  const siblings = new Map<number, readonly BacklogItem[]>();
  const siblingIndex = new Map<number, number>();
  const parents = new Set<number>();
  const levels = new Map<number, number>();

  const walk = (node: BacklogGroup, level: number): void => {
    byId.set(node.item.id, node.item);
    levels.set(node.item.id, level);
    if (visible.has(node.item.id)) rows.push(node.item);
    if (node.children.length === 0) return;
    parents.add(node.item.id);
    const children = node.children.map((child) => child.item);
    siblings.set(node.item.id, children);
    children.forEach((child, index) => siblingIndex.set(child.id, index));
    for (const child of node.children) walk(child, level + 1);
  };

  const roots = groups.map((group) => group.item);
  // Key 0 is "the top level": `parentId` is null there, and no item can have
  // id 0 because ids are positive.
  siblings.set(0, roots);
  roots.forEach((root, index) => siblingIndex.set(root.id, index));
  for (const group of groups) walk(group, 1);

  return { byId, rows, siblingIndex, siblings, parents, order: rows.map((row) => row.id), levels };
}

/** Children of `parentId` in render order; `null` means the top level. */
function groupOf(targets: BacklogTargets, parentId: number | null): readonly BacklogItem[] {
  return (parentId === null ? targets.siblings.get(0) : targets.siblings.get(parentId)) ?? [];
}

/**
 * Build the move that puts `item` immediately before `beforeId` among the
 * children of `parentId`. Returns `null` when that is where the item already
 * is, when the anchor is the item itself, or when the API would refuse it.
 */
export function backlogInsertMove(
  targets: BacklogTargets,
  itemId: number,
  parentId: number | null,
  beforeId: number | null,
): BacklogMove | null {
  const item = targets.byId.get(itemId);
  if (item === undefined) return null;
  // A Task needs a parent. This is the server's rule too, but refusing it here
  // means the user sees the reason instead of a round trip.
  if (item.type === "task" && parentId === null) return null;
  if (parentId !== null && !targets.byId.has(parentId)) return null;
  // An item cannot become its own child: that is an immediate cycle, and the
  // server refuses a self-referential parent.
  if (parentId === itemId) return null;
  // `beforeId` must be a real sibling of the destination. A foreign anchor is
  // rejected server-side, so it is never sent from here.
  if (beforeId !== null) {
    const anchor = targets.byId.get(beforeId);
    if (anchor === undefined) return null;
    const anchorParent = anchor.parentId !== null && targets.byId.has(anchor.parentId) ? anchor.parentId : null;
    if (anchorParent !== parentId) return null;
  }
  const siblings = groupOf(targets, parentId);
  const index = siblings.findIndex((sibling) => sibling.id === itemId);
  // Where the item would land: in front of the anchor, or at the end when the
  // anchor is absent. `findIndex` returning -1 is exactly "append".
  const destination = beforeId === null ? siblings.length : siblings.findIndex((sibling) => sibling.id === beforeId);
  // Already on that line. Inserting before the sibling that immediately follows
  // is also a no-op, because that is exactly where the item already sits.
  if (index === destination) return null;
  if (index !== -1 && index + 1 === destination) return null;
  // `beforeId` is never the item itself here, because that would have made the
  // destination its own index and returned above.
  const anchor = beforeId === null ? null : targets.byId.get(beforeId) ?? null;
  return {
    itemId,
    parentId,
    beforeId,
    announcement: anchor === null
      ? `Moved ${backlogItemLabel(item)} to the end of ${describeParent(targets, parentId)}.`
      : `Moved ${backlogItemLabel(item)} before ${backlogItemLabel(anchor)}.`,
  };
}

function describeParent(targets: BacklogTargets, parentId: number | null): string {
  if (parentId === null) return "the top level";
  const parent = targets.byId.get(parentId);
  return parent === undefined ? "the top level" : `the children of ${backlogItemLabel(parent)}`;
}

/** The item's own sibling group, in render order. */
function siblingGroup(targets: BacklogTargets, item: BacklogItem): readonly BacklogItem[] {
  return groupOf(targets, item.parentId !== null && targets.byId.has(item.parentId) ? item.parentId : null);
}

/** The sibling that currently precedes `item`, or `null` at the top of its group. */
function previousSibling(targets: BacklogTargets, item: BacklogItem): BacklogItem | null {
  const siblings = siblingGroup(targets, item);
  const index = siblings.findIndex((sibling) => sibling.id === item.id);
  return index <= 0 ? null : siblings[index - 1] ?? null;
}

/**
 * Wrap a keyboard action so it reports where focus belongs once it lands. A
 * `null` label means the move is not available from this row's position, so
 * the control is simply not rendered.
 */
function action(id: string, label: string | null, move: BacklogMove | null, focusRowId: number | null): BacklogMoveAction | null {
  if (move === null || label === null) return null;
  return { id, label, move, focusRowId };
}

/**
 * Every keyboard equivalent of a drag for one row, in the order they are
 * offered. Each returned action is legal from this row's position; the caller
 * renders a control for all four directions regardless, so an unavailable one
 * keeps its place in the tab order and explains itself (see
 * {@link backlogMoveActionReason}).
 */
export function backlogMoveActions(targets: BacklogTargets, item: BacklogItem): readonly BacklogMoveAction[] {
  const parentId = item.parentId !== null && targets.byId.has(item.parentId) ? item.parentId : null;
  const siblings = siblingGroup(targets, item);
  const index = siblings.findIndex((sibling) => sibling.id === item.id);
  // Moving up means landing in front of the sibling that immediately precedes
  // the item, which is always a real step: the item currently sits after it.
  const upAnchor = index > 0 ? siblings[index - 1] ?? null : undefined;
  // Moving down means landing in front of the sibling after the next one, which
  // swaps the item with its immediate follower. `null` appends, which is the
  // right answer when the item is second-to-last.
  const downAnchor = index === -1 || index >= siblings.length - 1 ? undefined : siblings[index + 2]?.id ?? null;
  const previous = previousSibling(targets, item);
  const parent = parentId === null ? null : targets.byId.get(parentId) ?? null;
  const name = backlogItemLabel(item);

  const collected: Array<BacklogMoveAction | null> = [];
  if (upAnchor !== undefined) {
    collected.push(action("up", `Move ${name} up one place`, backlogInsertMove(targets, item.id, parentId, upAnchor?.id ?? null), item.id));
  }
  if (downAnchor !== undefined) {
    collected.push(action("down", `Move ${name} down one place`, backlogInsertMove(targets, item.id, parentId, downAnchor), item.id));
  }

  // Indent: become the last child of the previous sibling. This is the keyboard
  // equivalent of dropping a row onto the item above it.
  if (previous !== null) {
    collected.push(action(
      "indent",
      `Make ${name} a child of ${backlogItemLabel(previous)}`,
      backlogInsertMove(targets, item.id, previous.id, null),
      item.id,
    ));
  }

  // Outdent: leave the parent's group and follow that parent into the group
  // above it, which is the keyboard equivalent of dragging a row one level out.
  if (parent !== null) {
    const grandParent = parent.parentId !== null && targets.byId.has(parent.parentId) ? parent.parentId : null;
    collected.push(action(
      "outdent",
      `Move ${name} out of ${backlogItemLabel(parent)}`,
      backlogInsertMove(targets, item.id, grandParent, parent.id),
      parent.id,
    ));
  }

  // Promote to the top level. Only a nested, non-Task item can take this move:
  // a Task is required to have a parent, and a root item is already there.
  if (parent !== null && typeAllowsRoot(item)) {
    collected.push(action(
      "root",
      `Move ${name} to the top level`,
      backlogInsertMove(targets, item.id, null, null),
      item.id,
    ));
  }

  return collected.filter((candidate): candidate is BacklogMoveAction => candidate !== null);
}

/**
 * The four directions a row can move, whether or not this row can take them.
 *
 * Every row renders all four controls so the move column is the same shape
 * everywhere and a keyboard user always finds the same number of tab stops. An
 * unavailable direction is `aria-disabled` rather than absent, and this is what
 * tells it why — an omitted button cannot explain itself.
 */
export const BACKLOG_MOVE_DIRECTIONS = ["up", "down", "indent", "outdent"] as const;
export type BacklogMoveDirection = (typeof BACKLOG_MOVE_DIRECTIONS)[number];

/** The arrow/mark drawn for a direction; the label carries the meaning. */
export const BACKLOG_DIRECTION_MARKS: Readonly<Record<BacklogMoveDirection, string>> = {
  up: "\u2191",
  down: "\u2193",
  indent: "\u21b3",
  outdent: "\u21b0",
};

/**
 * Why this row cannot move in `direction`, in the words a screen reader will
 * read from the disabled control's own label.
 */
export function backlogMoveDirectionReason(
  targets: BacklogTargets,
  item: BacklogItem,
  direction: BacklogMoveDirection,
): string {
  const siblings = siblingGroup(targets, item);
  const index = siblings.findIndex((sibling) => sibling.id === item.id);
  const name = backlogItemLabel(item);
  switch (direction) {
    case "up":
      return `Cannot move ${name} up one place: it is already the first item in this group`;
    case "down":
      return `Cannot move ${name} down one place: it is already the last item in this group`;
    case "indent":
      return `Cannot make ${name} a child of the previous item: it has no previous sibling`;
    case "outdent":
      return `Cannot move ${name} out of its parent: it is already at the top level`;
    default:
      // Unreachable for a typed caller; kept so an unexpected id cannot render
      // an unlabelled control.
      void index;
      return `Cannot move ${name} in that direction`;
  }
}

/** A Task cannot live at the top level; every other type can. */
export function typeAllowsRoot(item: BacklogItem): boolean {
  return item.type !== "task";
}

/** Why a top-level drop of this item is refused, for the live region. */
export function rootRefusalMessage(item: BacklogItem): string {
  return `${WORK_ITEM_TYPE_LABELS[item.type]} #${item.id} \u201C${item.title}\u201D is a Task, so it needs a parent and cannot be moved to the top level.`;
}

/**
 * Why a locally refused move was refused, in the user's words.
 *
 * The pointer path and the keyboard path both ask this, so a Task dropped at
 * the top level and the same rule hit by a move button cannot explain
 * themselves differently. Callers only ask once they know the move will not be
 * issued, so every branch here describes a real refusal; a `null` parentId
 * with a non-Task item is therefore not reachable.
 */
export function dropRefusalMessage(item: BacklogItem, parentId: number | null): string {
  if (item.type === "task" && parentId === null) return rootRefusalMessage(item);
  return `Cannot move ${backlogItemLabel(item)} there.`;
}

/** Where a pointer drop lands, decided from the row under the pointer. */
export interface BacklogDropTarget {
  readonly parentId: number | null;
  readonly beforeId: number | null;
}

/**
 * Resolve a drop onto `rowId`. A drop in the middle of a row or on its handle
 * inserts before it; a drop on the lower half of a row nests inside it, which
 * is the same gesture as dropping a file into a folder. Dropping a row onto
 * itself is never a move.
 */
export function backlogDropTarget(
  targets: BacklogTargets,
  itemId: number,
  rowId: number,
  nested: boolean,
): BacklogDropTarget | null {
  if (itemId === rowId) return null;
  const row = targets.byId.get(rowId);
  if (row === undefined) return null;
  // A drop of any ancestor onto its own descendant would make a cycle.
  if (isDescendantOf(targets, rowId, itemId)) return null;
  if (nested) return { parentId: rowId, beforeId: null };
  const parentId = row.parentId !== null && targets.byId.has(row.parentId) ? row.parentId : null;
  return { parentId, beforeId: rowId };
}

/** True when `candidateId` is `itemId` itself or sits somewhere below it. */
export function isDescendantOf(targets: BacklogTargets, candidateId: number, itemId: number): boolean {
  let current: number | null = candidateId;
  const seen = new Set<number>();
  while (current !== null) {
    if (current === itemId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    const item = targets.byId.get(current);
    current = item === undefined || item.parentId === null || !targets.byId.has(item.parentId) ? null : item.parentId;
  }
  return false;
}

/** Row ids the drop zone should highlight for a given drag. */
export function isDroppableRow(targets: BacklogTargets, itemId: number, rowId: number): boolean {
  return itemId !== rowId && !isDescendantOf(targets, rowId, itemId);
}

/** Level a row is drawn at, capped so deep trees cannot run off the screen. */
export function displayLevel(level: number): number {
  return Math.min(Math.max(level, 1), MAX_ROW_LEVEL);
}
