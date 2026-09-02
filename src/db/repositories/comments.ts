import type { Database } from "bun:sqlite";
import { decodeCreatedAtIdCursor, encodeCursor } from "../cursor";

export interface CommentRow {
  readonly id: number;
  readonly item_id: number;
  readonly author_id: number;
  readonly body: string;
  readonly created_at: string;
}

/** Comment row joined with author identity. */
export interface CommentJoinedRow extends CommentRow {
  readonly author_name: string;
  readonly author_kind: "human" | "agent";
}

const COMMENT_SELECT =
  "SELECT c.id, c.item_id, c.author_id, c.body, c.created_at, p.name AS author_name, p.kind AS author_kind " +
  "FROM comments c JOIN participants p ON p.id = c.author_id";

export function createComment(
  db: Database,
  input: { readonly itemId: number; readonly authorId: number; readonly body: string; readonly createdAt: string },
): CommentRow {
  const row = db
    .query(
      "INSERT INTO comments (item_id, author_id, body, created_at) VALUES (?, ?, ?, ?) " +
        "RETURNING id, item_id, author_id, body, created_at",
    )
    .get(input.itemId, input.authorId, input.body, input.createdAt);
  return row as CommentRow;
}

export function getCommentById(db: Database, id: number): CommentRow | null {
  const row = db
    .query("SELECT id, item_id, author_id, body, created_at FROM comments WHERE id = ?")
    .get(id);
  return (row as CommentRow | null) ?? null;
}

// Oldest first, deterministic (created_at ASC, id ASC) with an encoded cursor.
export function listComments(
  db: Database,
  itemId: number,
  options: { readonly limit: number; readonly cursor?: string | null },
): { readonly comments: CommentJoinedRow[]; readonly nextCursor: string | null } {
  const cursor = options.cursor ? decodeCreatedAtIdCursor(options.cursor) : null;
  const conditions: string[] = ["c.item_id = ?"];
  const params: Array<string | number> = [itemId];
  if (cursor) {
    conditions.push("(c.created_at > ? OR (c.created_at = ? AND c.id > ?))");
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const rows = db
    .query(`${COMMENT_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY c.created_at ASC, c.id ASC LIMIT ?`)
    .all(...params, options.limit) as CommentJoinedRow[];

  let nextCursor: string | null = null;
  if (rows.length === options.limit) {
    const last = rows[rows.length - 1];
    if (last) nextCursor = encodeCursor([last.created_at, last.id]);
  }
  return { comments: rows, nextCursor };
}
