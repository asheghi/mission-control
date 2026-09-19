import type { Database } from "bun:sqlite";
import type { Priority, WorkStatus } from "../../domain/types";
import {
  decodeCreatedAtIdCursor,
  decodeDoneFlagUpdatedAtIdCursor,
  decodeUpdatedAtIdCursor,
  encodeCursor,
} from "../cursor";

type SqlValue = string | number | bigint | boolean | null;

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
  },
): ItemRow {
  const row = db
    .query(
      "INSERT INTO items (title, body, status, priority, assignee_id, created_by, created_at, updated_at, closed_at, parent_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "RETURNING id, title, body, status, priority, assignee_id, created_by, created_at, updated_at, closed_at, parent_id",
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
    );
  return row as ItemRow;
}

export function getItemById(db: Database, id: number): ItemRow | null {
  const row = db
    .query(
      "SELECT id, title, body, status, priority, assignee_id, created_by, created_at, updated_at, closed_at, parent_id " +
        "FROM items WHERE id = ?",
    )
    .get(id);
  return (row as ItemRow | null) ?? null;
}

export function getItemJoined(db: Database, id: number): ItemJoinedRow | null {
  const row = db.query(`${ITEM_SELECT} WHERE items.id = ?`).get(id);
  return (row as ItemJoinedRow | null) ?? null;
}

export interface ItemListFilter {
  readonly statusIn?: readonly WorkStatus[];
  readonly assigneeId?: number;
  readonly unassigned?: boolean;
  readonly labelId?: number;
  readonly q?: string;
  readonly parentId?: number | null;
  readonly limit: number;
  readonly cursor?: string | null;
}

// Deterministic pagination: (updated_at DESC, id DESC) with an encoded
// [updatedAt, id] cursor.
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
  if (filter.cursor) {
    const cursor = decodeUpdatedAtIdCursor(filter.cursor);
    conditions.push("(items.updated_at < ? OR (items.updated_at = ? AND items.id < ?))");
    params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }

  const rows = db
    .query(`${ITEM_SELECT} ${whereClause(conditions)} ORDER BY items.updated_at DESC, items.id DESC LIMIT ?`)
    .all(...params, filter.limit) as ItemJoinedRow[];

  let nextCursor: string | null = null;
  if (rows.length === filter.limit) {
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
}

const ITEM_COLUMNS: Readonly<Record<string, string>> = {
  title: "title",
  body: "body",
  status: "status",
  priority: "priority",
  assigneeId: "assignee_id",
  closedAt: "closed_at",
  parentId: "parent_id",
};

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
    ...setEntries.map(([, value]) => value as SqlValue),
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
