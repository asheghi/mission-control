import type { Database } from "bun:sqlite";
import { ValidationError } from "../../domain/errors";
import type { Priority, WorkItemType, WorkStatus } from "../../domain/types";
import {
  decodeCreatedAtIdCursor,
  decodeDoneFlagUpdatedAtIdCursor,
  decodeUpdatedAtIdCursor,
  encodeCursor,
} from "../cursor";

type SqlValue = string | number | bigint | boolean | null;

/** Work-item types that may be created, in their canonical order. */
export const WORK_ITEM_TYPES: readonly WorkItemType[] = ["feature", "user_story", "bug", "task"];

/**
 * Statuses that belong to the backlog. `done` items are terminal and are never
 * part of backlog ordering.
 */
export const UNFINISHED_STATUSES: readonly WorkStatus[] = ["todo", "doing", "blocked"];

/**
 * Backlog positions are nonnegative. New siblings are appended at the position
 * one past the current maximum, so a compacted sibling gap never leaves the
 * NEW position equal to the OLD one it replaced.
 */
const FIRST_BACKLOG_POSITION = 0;

/** Item columns returned by every plain item read. */
const ITEM_COLUMNS_SQL =
  "id, title, body, status, priority, assignee_id, created_by, created_at, updated_at, closed_at, parent_id, work_item_type, backlog_position";

export interface ItemRow {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly status: WorkStatus;
  readonly priority: Priority;
  readonly assignee_id: number | null;
  readonly created_by: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
  readonly parent_id: number | null;
  readonly work_item_type: WorkItemType;
  readonly backlog_position: number;
}

/** Item row joined with assignee identity and comment count. */
export interface ItemJoinedRow extends ItemRow {
  readonly assignee_name: string | null;
  readonly assignee_kind: "human" | "agent" | null;
  readonly comment_count: number;
}

const ITEM_SELECT =
  "SELECT items.*, p.name AS assignee_name, p.kind AS assignee_kind, " +
  "(SELECT COUNT(*) FROM comments c WHERE c.item_id = items.id) AS comment_count " +
  "FROM items LEFT JOIN participants p ON p.id = items.assignee_id";

function whereClause(conditions: readonly string[]): string {
  return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
}

function isWorkItemType(value: string): value is WorkItemType {
  return (WORK_ITEM_TYPES as readonly string[]).includes(value);
}

/**
 * Rejects anything that could not have come from a validated caller. The
 * repository is the last gate before the CHECK constraints, so a bad value
 * surfaces as a domain error instead of a raw constraint failure.
 */
function requireWorkItemType(type: string): WorkItemType {
  if (!isWorkItemType(type)) {
    throw new ValidationError(
      `Invalid work item type ${JSON.stringify(type)}; expected one of ${WORK_ITEM_TYPES.join(", ")}.`,
    );
  }
  return type;
}

function requireBacklogPosition(position: number): number {
  if (!Number.isSafeInteger(position) || position < FIRST_BACKLOG_POSITION) {
    throw new ValidationError(
      `Invalid backlog position ${position}; expected a nonnegative integer.`,
    );
  }
  return position;
}

/** Appends to the end of the sibling list. */
function nextBacklogPosition(db: Database, parentId: number | null): number {
  const row = db
    .query(
      "SELECT COALESCE(MAX(backlog_position), -1) + 1 AS next_position FROM items " +
        (parentId === null ? "WHERE parent_id IS NULL" : "WHERE parent_id = ?"),
    )
    .get(...(parentId === null ? [] : [parentId])) as { next_position: number } | null;
  return requireBacklogPosition(row?.next_position ?? FIRST_BACKLOG_POSITION);
}

/**
 * Rewrites the sibling positions of one parent scope into 0..n-1 in the given
 * id order. Deterministic, and safe to run repeatedly.
 */
function compactPositions(db: Database, parentId: number | null, orderedIds: readonly number[]): void {
  const statement = db.query("UPDATE items SET backlog_position = ? WHERE id = ?");
  orderedIds.forEach((id, index) => {
    statement.run(index, id);
  });
}

/** Sibling ids of one parent scope in (backlog_position, id) order. */
function siblingIds(db: Database, parentId: number | null): number[] {
  const rows = db
    .query(
      "SELECT id FROM items " +
        (parentId === null ? "WHERE parent_id IS NULL" : "WHERE parent_id = ?") +
        " ORDER BY backlog_position ASC, id ASC",
    )
    .all(...(parentId === null ? [] : [parentId])) as { id: number }[];
  return rows.map((row) => row.id);
}

/**
 * Validates a `beforeId` anchor: it must exist, live under `parentId`, and not
 * be the item being moved (which would make the move a no-op with an ambiguous
 * destination).
 */
function requireSiblingAnchor(db: Database, beforeId: number, parentId: number | null, movingId: number): void {
  if (beforeId === movingId) {
    throw new ValidationError("An item cannot be repositioned before itself.");
  }
  const row = db.query("SELECT parent_id FROM items WHERE id = ?").get(beforeId) as {
    parent_id: number | null;
  } | null;
  if (row === null) throw new ValidationError(`Unknown backlog anchor item ${beforeId}.`);
  if (row.parent_id !== parentId) {
    throw new ValidationError(
      `Backlog anchor item ${beforeId} is not a sibling under parent ${parentId === null ? "root" : parentId}.`,
    );
  }
}

export function createItem(
  db: Database,
  input: {
    readonly title: string;
    readonly body: string;
    readonly status: WorkStatus;
    readonly priority: Priority;
    readonly assigneeId: number | null;
    readonly createdBy: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly closedAt: string | null;
    readonly parentId: number | null;
    readonly workItemType: WorkItemType;
    /** Defaults to the end of the sibling list. */
    readonly backlogPosition?: number;
  },
): ItemRow {
  const workItemType = requireWorkItemType(input.workItemType);
  const backlogPosition =
    input.backlogPosition === undefined
      ? nextBacklogPosition(db, input.parentId)
      : requireBacklogPosition(input.backlogPosition);
  const row = db
    .query(
      "INSERT INTO items (title, body, status, priority, assignee_id, created_by, created_at, updated_at, closed_at, parent_id, work_item_type, backlog_position) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        `RETURNING ${ITEM_COLUMNS_SQL}`,
    )
    .get(
      input.title,
      input.body,
      input.status,
      input.priority,
      input.assigneeId,
      input.createdBy,
      input.createdAt,
      input.updatedAt,
      input.closedAt,
      input.parentId,
      workItemType,
      backlogPosition,
    );
  return row as ItemRow;
}

export function getItemById(db: Database, id: number): ItemRow | null {
  const row = db.query(`SELECT ${ITEM_COLUMNS_SQL} FROM items WHERE id = ?`).get(id);
  return (row as ItemRow | null) ?? null;
}

export function getItemJoined(db: Database, id: number): ItemJoinedRow | null {
  const row = db.query(`${ITEM_SELECT} WHERE items.id = ?`).get(id);
  return (row as ItemJoinedRow | null) ?? null;
}

export interface ItemListFilter {
  readonly statusIn?: readonly WorkStatus[];
  readonly typeIn?: readonly WorkItemType[];
  readonly assigneeId?: number;
  readonly unassigned?: boolean;
  readonly labelId?: number;
  readonly q?: string;
  readonly parentId?: number | null;
  /** Inclusive lower/upper bounds on the sibling backlog position. */
  readonly minBacklogPosition?: number;
  readonly maxBacklogPosition?: number;
  /**
   * Orders by (parent_id, backlog_position, id) instead of recency. Backlog
   * order is positional, so a cursor would silently drop siblings when
   * positions change between pages.
   */
  readonly order?: "recent" | "backlog";
  readonly limit: number;
  readonly cursor?: string | null;
}

/** Deterministic backlog order: parent scope first, then position, then id. */
const BACKLOG_ORDER_SQL = "ORDER BY items.parent_id ASC, items.backlog_position ASC, items.id ASC";

const RECENT_ORDER_SQL = "ORDER BY items.updated_at DESC, items.id DESC";

// Deterministic pagination: (updated_at DESC, id DESC) with an encoded
// [updatedAt, id] cursor. `order: "backlog"` switches to positional sibling
// order and does not paginate.
export function listItems(
  db: Database,
  filter: ItemListFilter,
): { readonly items: ItemJoinedRow[]; readonly nextCursor: string | null } {
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  if (filter.statusIn && filter.statusIn.length > 0) {
    conditions.push(`items.status IN (${filter.statusIn.map(() => "?").join(", ")})`);
    params.push(...filter.statusIn);
  }
  if (filter.typeIn && filter.typeIn.length > 0) {
    conditions.push(`items.work_item_type IN (${filter.typeIn.map(() => "?").join(", ")})`);
    params.push(...filter.typeIn);
  }
  if (filter.unassigned) {
    conditions.push("items.assignee_id IS NULL");
  } else if (filter.assigneeId !== undefined) {
    conditions.push("items.assignee_id = ?");
    params.push(filter.assigneeId);
  }
  if (filter.labelId !== undefined) {
    conditions.push(
      "EXISTS (SELECT 1 FROM item_labels il WHERE il.item_id = items.id AND il.label_id = ?)",
    );
    params.push(filter.labelId);
  }
  if (filter.q !== undefined && filter.q.length > 0) {
    const pattern = `%${filter.q.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push("(items.title LIKE ? ESCAPE '\\' OR items.body LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  if (filter.parentId !== undefined) {
    if (filter.parentId === null) conditions.push("items.parent_id IS NULL");
    else {
      conditions.push("items.parent_id = ?");
      params.push(filter.parentId);
    }
  }
  if (filter.minBacklogPosition !== undefined) {
    conditions.push("items.backlog_position >= ?");
    params.push(requireBacklogPosition(filter.minBacklogPosition));
  }
  if (filter.maxBacklogPosition !== undefined) {
    conditions.push("items.backlog_position <= ?");
    params.push(requireBacklogPosition(filter.maxBacklogPosition));
  }
  if (filter.cursor) {
    const cursor = decodeUpdatedAtIdCursor(filter.cursor);
    conditions.push("(items.updated_at < ? OR (items.updated_at = ? AND items.id < ?))");
    params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }

  const usingBacklogOrder = filter.order === "backlog";
  const rows = db
    .query(
      `${ITEM_SELECT} ${whereClause(conditions)} ${usingBacklogOrder ? BACKLOG_ORDER_SQL : RECENT_ORDER_SQL} LIMIT ?`,
    )
    .all(...params, filter.limit) as ItemJoinedRow[];

  let nextCursor: string | null = null;
  if (!usingBacklogOrder && rows.length === filter.limit) {
    const last = rows[rows.length - 1];
    if (last) nextCursor = encodeCursor([last.updated_at, last.id]);
  }
  return { items: rows, nextCursor };
}

export interface MyWorkFilter {
  readonly status?: WorkStatus;
  readonly limit: number;
  readonly cursor?: string | null;
}

export interface MyWorkRow extends ItemJoinedRow {
  readonly assigned: 0 | 1;
  readonly mentioned: 0 | 1;
}

// Assigned OR mentioned, deduplicated by item id (single query with reason
// flags), open items first, then most recently updated. Parameter order follows
// SQL placeholder order: the two SELECT-clause flags, then WHERE, then LIMIT.
// my_work needs two extra SELECT columns (reason flags), so it uses its own
// SELECT list. Placeholder order: the two SELECT flags, then WHERE, then LIMIT.
const MY_WORK_SELECT =
  "SELECT items.*, p.name AS assignee_name, p.kind AS assignee_kind, " +
  "(SELECT COUNT(*) FROM comments c WHERE c.item_id = items.id) AS comment_count, " +
  "COALESCE(items.assignee_id = ?, 0) AS assigned, " +
  "EXISTS (SELECT 1 FROM mentions mm WHERE mm.item_id = items.id AND mm.participant_id = ?) AS mentioned " +
  "FROM items LEFT JOIN participants p ON p.id = items.assignee_id";

export function myWork(
  db: Database,
  participantId: number,
  filter: MyWorkFilter,
): { readonly items: MyWorkRow[]; readonly nextCursor: string | null } {
  const selectParams: SqlValue[] = [participantId, participantId];

  const conditions: string[] = [
    "(items.assignee_id = ? OR EXISTS (SELECT 1 FROM mentions m WHERE m.item_id = items.id AND m.participant_id = ?))",
  ];
  const whereParams: SqlValue[] = [participantId, participantId];

  if (filter.status) {
    conditions.push("items.status = ?");
    whereParams.push(filter.status);
  }
  if (filter.cursor) {
    // Cursor tuple: [doneFlag, updatedAt, id] matching the ORDER BY.
    const cursor = decodeDoneFlagUpdatedAtIdCursor(filter.cursor);
    conditions.push(
      "((items.status = 'done') > ? OR ((items.status = 'done') = ? AND " +
        "(items.updated_at < ? OR (items.updated_at = ? AND items.id < ?))))",
    );
    whereParams.push(cursor.doneFlag, cursor.doneFlag, cursor.updatedAt, cursor.updatedAt, cursor.id);
  }

  const rows = db
    .query(
      `${MY_WORK_SELECT} ${whereClause(conditions)} ORDER BY (items.status = 'done') ASC, items.updated_at DESC, items.id DESC LIMIT ?`,
    )
    .all(...selectParams, ...whereParams, filter.limit) as MyWorkRow[];

  let nextCursor: string | null = null;
  if (rows.length === filter.limit) {
    const last = rows[rows.length - 1];
    if (last) nextCursor = encodeCursor([last.status === "done" ? 1 : 0, last.updated_at, last.id]);
  }
  return { items: rows, nextCursor };
}

export interface ItemColumnChanges {
  title?: string;
  body?: string;
  status?: WorkStatus;
  priority?: Priority;
  // Key presence means "set", including null to unassign.
  assigneeId?: number | null;
  closedAt?: string | null;
  parentId?: number | null;
  workItemType?: WorkItemType;
  backlogPosition?: number;
}

const ITEM_COLUMNS: Readonly<Record<string, string>> = {
  title: "title",
  body: "body",
  status: "status",
  priority: "priority",
  assigneeId: "assignee_id",
  closedAt: "closed_at",
  parentId: "parent_id",
  workItemType: "work_item_type",
  backlogPosition: "backlog_position",
};

/** Rejects out-of-domain values before they reach the CHECK constraints. */
function validateColumnValue(key: string, value: SqlValue): SqlValue {
  if (key === "workItemType") return requireWorkItemType(value as string);
  if (key === "backlogPosition") return requireBacklogPosition(value as number);
  return value;
}

export function updateItem(
  db: Database,
  id: number,
  changes: ItemColumnChanges,
  updatedAt: string,
): boolean {
  const setEntries = Object.entries(changes).filter(
    ([key, value]) => ITEM_COLUMNS[key] !== undefined && value !== undefined,
  );

  const setClause = [
    ...setEntries.map(([key]) => `${ITEM_COLUMNS[key]} = ?`),
    "updated_at = ?",
  ].join(", ");
  const params: SqlValue[] = [
    ...setEntries.map(([key, value]) => validateColumnValue(key, value as SqlValue)),
    updatedAt,
  ];

  // Note: sqlite3_changes() counts foreign-key action rows too (e.g. the
  // cascaded history/comment/mention deletions), so any positive count means
  // the target row was affected.
  const result = db.query(`UPDATE items SET ${setClause} WHERE id = ?`).run(...params, id);
  return result.changes > 0;
}

export function deleteItem(db: Database, id: number): boolean {
  const result = db.query("DELETE FROM items WHERE id = ?").run(id);
  return result.changes > 0;
}

// ------------------------------------------------------------ ordered backlog

export interface BacklogQuery {
  /**
   * Restricts the result to one parent scope. Omit for every unfinished item
   * regardless of parent — the query never paginates and never caps.
   */
  readonly parentId?: number | null;
}

/**
 * Every unfinished (todo/doing/blocked) item in deterministic backlog order:
 * (parent_id, backlog_position, id). Deliberately uncapped — an item limit
 * would silently truncate a backlog larger than the page size — and unpaginated
 * so a caller always receives a complete, correctly grouped sibling set.
 */
export function listBacklogItems(db: Database, query: BacklogQuery = {}): ItemJoinedRow[] {
  const conditions = [`items.status IN (${UNFINISHED_STATUSES.map(() => "?").join(", ")})`];
  const params: SqlValue[] = [...UNFINISHED_STATUSES];

  if (query.parentId !== undefined) {
    if (query.parentId === null) conditions.push("items.parent_id IS NULL");
    else {
      conditions.push("items.parent_id = ?");
      params.push(query.parentId);
    }
  }

  return db
    .query(`${ITEM_SELECT} ${whereClause(conditions)} ${BACKLOG_ORDER_SQL}`)
    .all(...params) as ItemJoinedRow[];
}

/** Unfinished sibling ids of one parent scope in backlog order. */
export function listBacklogSiblingIds(db: Database, parentId: number | null): number[] {
  return listBacklogItems(db, { parentId }).map((row) => row.id);
}

export interface AppendToBacklogInput {
  readonly parentId: number | null;
  /** Omit to use the end of the sibling list. */
  readonly backlogPosition?: number;
}

/**
 * Position for a newly appended sibling. Read inside the caller's transaction
 * so concurrent appends under the same parent serialize instead of colliding.
 */
export function resolveAppendPosition(db: Database, input: AppendToBacklogInput): number {
  const maxRow = db
    .query(
      "SELECT COALESCE(MAX(backlog_position), -1) AS max_position FROM items " +
        (input.parentId === null ? "WHERE parent_id IS NULL" : "WHERE parent_id = ?"),
    )
    .get(...(input.parentId === null ? [] : [input.parentId])) as { max_position: number } | null;
  const next = requireBacklogPosition((maxRow?.max_position ?? -1) + 1);
  if (input.backlogPosition !== undefined) {
    return requireBacklogPosition(Math.max(next, input.backlogPosition));
  }
  return next;
}

export interface MoveItemInput {
  readonly itemId: number;
  /** Destination parent scope; null means top level. */
  readonly parentId: number | null;
  /** Insert immediately before this sibling; omit to append to the end. */
  readonly beforeId?: number | null;
}

export interface MoveItemResult {
  readonly itemId: number;
  readonly parentId: number | null;
  readonly backlogPosition: number;
}

/**
 * Moves (and optionally reparents) one item within backlog order.
 *
 * The old and new sibling scopes are both compacted to 0..n-1 after the move,
 * so ordering stays gap-free and deterministic no matter how many moves ran
 * before. Validation lives here because only the repository can see the anchor
 * rows: an unknown anchor, an anchor in another parent scope, a self-anchor,
 * an unknown item, and self-parenting are all rejected before any write.
 *
 * Callers must wrap this in `db.transaction(...)`; reads and writes are issued
 * as separate statements on purpose so the caller owns atomicity.
 */
export function moveItemInBacklog(db: Database, input: MoveItemInput): MoveItemResult {
  const current = db.query("SELECT parent_id, backlog_position FROM items WHERE id = ?").get(input.itemId) as {
    parent_id: number | null;
    backlog_position: number;
  } | null;
  if (current === null) throw new ValidationError(`Unknown item ${input.itemId}.`);

  if (input.parentId !== null && input.parentId === input.itemId) {
    throw new ValidationError("An item cannot be its own parent.");
  }
  if (input.parentId !== null) {
    const parent = db.query("SELECT id FROM items WHERE id = ?").get(input.parentId) as { id: number } | null;
    if (parent === null) throw new ValidationError(`Unknown parent item ${input.parentId}.`);
  }

  const beforeId = input.beforeId ?? null;
  if (beforeId !== null) requireSiblingAnchor(db, beforeId, input.parentId, input.itemId);

  const oldParentId = current.parent_id;
  const oldSiblings = siblingIds(db, oldParentId).filter((id) => id !== input.itemId);
  const newSiblings = siblingIds(db, input.parentId).filter((id) => id !== input.itemId);

  // `requireSiblingAnchor` already proved the anchor is a sibling in this
  // scope, so indexOf cannot miss.
  const anchorIndex = beforeId === null ? -1 : newSiblings.indexOf(beforeId);
  const insertAt = anchorIndex < 0 ? newSiblings.length : anchorIndex;
  newSiblings.splice(insertAt, 0, input.itemId);

  // Park the moved row above every position either scope can use, then
  // reparent it. Parking first matters for a same-parent reorder: the row would
  // otherwise still hold its old position when the destination compaction runs
  // and would be overwritten by whichever sibling claims that slot.
  const parkedPosition = requireBacklogPosition(oldSiblings.length + newSiblings.length + 1);
  db.query("UPDATE items SET parent_id = ?, backlog_position = ? WHERE id = ?").run(
    input.parentId,
    parkedPosition,
    input.itemId,
  );

  // Old scope first: when both scopes are the same, the destination compaction
  // must run last so it owns the moved row's final position.
  if (oldParentId !== input.parentId) compactPositions(db, oldParentId, oldSiblings);
  compactPositions(db, input.parentId, newSiblings);

  return { itemId: input.itemId, parentId: input.parentId, backlogPosition: insertAt };
}
