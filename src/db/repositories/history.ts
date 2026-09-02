import type { Database } from "bun:sqlite";
import { decodeCreatedAtIdCursor, encodeCursor } from "../cursor";

export interface HistoryRow {
  readonly id: number;
  readonly item_id: number;
  readonly actor_id: number;
  readonly field: string;
  readonly old_value: string | null;
  readonly new_value: string | null;
  readonly created_at: string;
}

/** History row joined with the actor's display name. */
export interface HistoryJoinedRow extends HistoryRow {
  readonly actor_name: string;
}

export function appendHistory(
  db: Database,
  input: {
    readonly itemId: number;
    readonly actorId: number;
    readonly field: string;
    readonly oldValue: string | null;
    readonly newValue: string | null;
    readonly createdAt: string;
  },
): HistoryRow {
  const row = db
    .query(
      "INSERT INTO history (item_id, actor_id, field, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "RETURNING id, item_id, actor_id, field, old_value, new_value, created_at",
    )
    .get(input.itemId, input.actorId, input.field, input.oldValue, input.newValue, input.createdAt);
  return row as HistoryRow;
}

export function listHistory(
  db: Database,
  itemId: number,
  options: { readonly limit: number; readonly cursor?: string | null },
): { readonly entries: HistoryJoinedRow[]; readonly nextCursor: string | null } {
  const cursor = options.cursor ? decodeCreatedAtIdCursor(options.cursor) : null;
  const conditions: string[] = ["h.item_id = ?"];
  const params: Array<string | number> = [itemId];
  if (cursor) {
    conditions.push("(h.created_at > ? OR (h.created_at = ? AND h.id > ?))");
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const rows = db
    .query(
      "SELECT h.id, h.item_id, h.actor_id, h.field, h.old_value, h.new_value, h.created_at, p.name AS actor_name " +
        "FROM history h JOIN participants p ON p.id = h.actor_id " +
        `WHERE ${conditions.join(" AND ")} ORDER BY h.created_at ASC, h.id ASC LIMIT ?`,
    )
    .all(...params, options.limit) as HistoryJoinedRow[];

  let nextCursor: string | null = null;
  if (rows.length === options.limit) {
    const last = rows[rows.length - 1];
    if (last) nextCursor = encodeCursor([last.created_at, last.id]);
  }
  return { entries: rows, nextCursor };
}
