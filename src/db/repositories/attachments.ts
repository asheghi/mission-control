import type { Database } from "bun:sqlite";

export type AttachmentState = "pending" | "committed";

export interface AttachmentRow {
  readonly id: number;
  readonly item_id: number | null;
  readonly comment_id: number | null;
  readonly storage_key: string;
  readonly filename: string;
  readonly media_type: string;
  readonly size_bytes: number | null;
  readonly sha256: string | null;
  readonly state: AttachmentState;
  readonly created_by: number;
  readonly created_at: string;
  readonly committed_at: string | null;
}

/** Attachment row joined with its uploader's display identity. */
export interface AttachmentJoinedRow extends AttachmentRow {
  readonly created_by_name: string;
  readonly created_by_kind: "human" | "agent";
}

const ATTACHMENT_COLUMNS =
  "a.id, a.item_id, a.comment_id, a.storage_key, a.filename, a.media_type, a.size_bytes, " +
  "a.sha256, a.state, a.created_by, a.created_at, a.committed_at";

/** The same list without the `a.` alias: RETURNING rejects an aliased column. */
const ATTACHMENT_RETURNING_COLUMNS =
  "id, item_id, comment_id, storage_key, filename, media_type, size_bytes, " +
  "sha256, state, created_by, created_at, committed_at";

const ATTACHMENT_SELECT =
  `SELECT ${ATTACHMENT_COLUMNS}, p.name AS created_by_name, p.kind AS created_by_kind FROM attachments a ` +
  "JOIN participants p ON p.id = a.created_by";

/**
 * Reserve a row before its bytes exist.
 *
 * The row is `pending` so the serving and listing paths never see a half-written
 * upload. The order matters: a row with no object is invisible and cheap, an
 * object with no row is an orphan that only maintenance can find.
 */
export function createPendingAttachment(
  db: Database,
  input: {
    readonly itemId: number | null;
    readonly commentId: number | null;
    readonly storageKey: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly createdBy: number;
    readonly createdAt: string;
  },
): AttachmentRow {
  const row = db
    .query(
      "INSERT INTO attachments (item_id, comment_id, storage_key, filename, media_type, state, created_by, created_at) " +
        `VALUES (?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING ${ATTACHMENT_RETURNING_COLUMNS}`,
    )
    .get(
      input.itemId,
      input.commentId,
      input.storageKey,
      input.filename,
      input.mediaType,
      input.createdBy,
      input.createdAt,
    );
  return row as AttachmentRow;
}

/**
 * Promote a pending row to `committed`.
 *
 * Returns null when the row vanished while its bytes were in flight — the
 * parent was deleted, for instance. The caller must then delete the object it
 * just wrote instead of leaving an orphan.
 */
export function commitAttachment(
  db: Database,
  id: number,
  input: { readonly sizeBytes: number; readonly sha256: string; readonly committedAt: string },
): AttachmentRow | null {
  const row = db
    .query(
      "UPDATE attachments SET state = 'committed', size_bytes = ?, sha256 = ?, committed_at = ? " +
        `WHERE id = ? AND state = 'pending' RETURNING ${ATTACHMENT_RETURNING_COLUMNS}`,
    )
    .get(input.sizeBytes, input.sha256, input.committedAt, id);
  return (row as AttachmentRow | null) ?? null;
}

export function getAttachmentById(db: Database, id: number): AttachmentJoinedRow | null {
  const row = db.query(`${ATTACHMENT_SELECT} WHERE a.id = ? AND a.state = 'committed'`).get(id);
  return (row as AttachmentJoinedRow | null) ?? null;
}

/**
 * The row behind an object, whatever its state. Used by the upload path to
 * finish a write it started, which is the one place a pending row is read back.
 */
export function getAttachmentRowById(db: Database, id: number): AttachmentRow | null {
  const row = db
    .query(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments a WHERE a.id = ?`)
    .get(id);
  return (row as AttachmentRow | null) ?? null;
}

export function listItemAttachments(db: Database, itemId: number): AttachmentJoinedRow[] {
  return db
    .query(`${ATTACHMENT_SELECT} WHERE a.item_id = ? AND a.state = 'committed' ORDER BY a.id ASC`)
    .all(itemId) as AttachmentJoinedRow[];
}

export function listCommentAttachments(db: Database, commentId: number): AttachmentJoinedRow[] {
  return db
    .query(`${ATTACHMENT_SELECT} WHERE a.comment_id = ? AND a.state = 'committed' ORDER BY a.id ASC`)
    .all(commentId) as AttachmentJoinedRow[];
}

/** Every committed attachment, for maintenance passes that must see all of them. */
export function listAllCommittedAttachments(db: Database): AttachmentRow[] {
  return db
    .query(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments a WHERE a.state = 'committed' ORDER BY a.id ASC`)
    .all() as AttachmentRow[];
}

export function listPendingAttachments(db: Database): AttachmentRow[] {
  return db
    .query(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments a WHERE a.state = 'pending' ORDER BY a.created_at ASC, a.id ASC`)
    .all() as AttachmentRow[];
}

/**
 * Delete an attachment. The blob-deletion queue is filled by a trigger on this
 * table, so the object is scheduled for removal inside this same transaction
 * whether the row goes directly, through an item delete, or through a comment
 * cascade. Returns false when the row was already gone.
 */
export function deleteAttachment(db: Database, id: number): boolean {
  const result = db.query("DELETE FROM attachments WHERE id = ?").run(id);
  return result.changes > 0;
}

export function deletePendingAttachment(db: Database, id: number): boolean {
  const result = db.query("DELETE FROM attachments WHERE id = ? AND state = 'pending'").run(id);
  return result.changes > 0;
}

// --- Blob deletion queue -----------------------------------------------------

export interface BlobDeletionRow {
  readonly storage_key: string;
  readonly enqueued_at: string;
  readonly attempts: number;
  readonly last_error: string | null;
}

export function listBlobDeletions(db: Database, limit = 100): BlobDeletionRow[] {
  return db
    .query("SELECT storage_key, enqueued_at, attempts, last_error FROM blob_deletions ORDER BY enqueued_at ASC, storage_key ASC LIMIT ?")
    .all(limit) as BlobDeletionRow[];
}

export function countBlobDeletions(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS n FROM blob_deletions").get() as { n: number };
  return row.n;
}

/** Drop a queue row once its object is actually gone. Idempotent by design. */
export function clearBlobDeletion(db: Database, storageKey: string): void {
  db.run("DELETE FROM blob_deletions WHERE storage_key = ?", [storageKey]);
}

/**
 * Record a failed attempt. The row stays queued: a delete that did not happen
 * must not be forgotten, and `attempts` is what lets `doctor` show a stuck one.
 */
export function recordBlobDeletionFailure(db: Database, storageKey: string, message: string): void {
  db.run(
    "UPDATE blob_deletions SET attempts = attempts + 1, last_error = ? WHERE storage_key = ?",
    [message.slice(0, 500), storageKey],
  );
}

/** The keys still owed a deletion, for reconciliation against the backend. */
export function listQueuedStorageKeys(db: Database): string[] {
  return (db.query("SELECT storage_key FROM blob_deletions").all() as Array<{ storage_key: string }>).map(
    (row) => row.storage_key,
  );
}
