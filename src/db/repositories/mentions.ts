import type { Database } from "bun:sqlite";

export interface MentionRow {
  readonly id: number;
  readonly item_id: number;
  readonly comment_id: number | null;
  readonly participant_id: number;
  readonly created_at: string;
}

/** Replaces item-body mentions; caller wraps in the mutation transaction. */
export function replaceItemMentions(
  db: Database,
  itemId: number,
  participantIds: readonly number[],
  createdAt: string,
): void {
  db.query("DELETE FROM mentions WHERE item_id = ? AND comment_id IS NULL").run(itemId);
  const insert = db.query(
    "INSERT OR IGNORE INTO mentions (item_id, comment_id, participant_id, created_at) VALUES (?, NULL, ?, ?)",
  );
  for (const participantId of participantIds) {
    insert.run(itemId, participantId, createdAt);
  }
}

/** Replaces mentions for a single comment; caller wraps in the mutation transaction. */
export function replaceCommentMentions(
  db: Database,
  itemId: number,
  commentId: number,
  participantIds: readonly number[],
  createdAt: string,
): void {
  db.query("DELETE FROM mentions WHERE comment_id = ?").run(commentId);
  const insert = db.query(
    "INSERT OR IGNORE INTO mentions (item_id, comment_id, participant_id, created_at) VALUES (?, ?, ?, ?)",
  );
  for (const participantId of participantIds) {
    insert.run(itemId, commentId, participantId, createdAt);
  }
}

export function listMentionsForItem(db: Database, itemId: number): MentionRow[] {
  const rows = db
    .query(
      "SELECT id, item_id, comment_id, participant_id, created_at FROM mentions WHERE item_id = ? ORDER BY id",
    )
    .all(itemId);
  return rows as MentionRow[];
}

export function listMentionedParticipantIds(db: Database, itemId: number): number[] {
  const rows = db
    .query("SELECT DISTINCT participant_id FROM mentions WHERE item_id = ? ORDER BY participant_id")
    .all(itemId) as Array<{ participant_id: number }>;
  return rows.map((row) => row.participant_id);
}
