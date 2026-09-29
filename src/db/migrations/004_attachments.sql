-- Migration 004: item and comment attachments.
--
-- Storage identity and storage bytes are deliberately separated. This table
-- owns the metadata and names the object; the object itself lives behind the
-- BlobStore (a directory by default, S3 optionally). SQLite cannot touch the
-- filesystem, so deletion is expressed as a durable queue row below rather than
-- as an action, and a partially uploaded file is represented as `pending` so it
-- is never listed or served.
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  -- Exactly one parent: an attachment hangs off an item or a comment, never
  -- both and never neither. The CHECK below is the authority; the two
  -- foreign keys only carry the cascade.
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  -- Opaque, server-generated, and never derived from the uploaded filename:
  -- a client-chosen value in a storage path is a traversal waiting to happen.
  storage_key TEXT NOT NULL UNIQUE,
  -- Display name only. Never used to build a path.
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER CHECK(size_bytes IS NULL OR size_bytes >= 0),
  -- Integrity metadata, not identity: no content addressing, so deleting one
  -- attachment can never strand another's bytes.
  sha256 TEXT CHECK(sha256 IS NULL OR length(sha256) = 64),
  state TEXT NOT NULL CHECK(state IN ('pending', 'committed')),
  created_by INTEGER NOT NULL REFERENCES participants(id),
  created_at TEXT NOT NULL,
  committed_at TEXT,
  CHECK((item_id IS NOT NULL) <> (comment_id IS NOT NULL)),
  -- A committed row is fully described: without these the serving path would
  -- have to guess a size or a type.
  CHECK(
    state = 'pending'
    OR (size_bytes IS NOT NULL AND sha256 IS NOT NULL AND committed_at IS NOT NULL)
  )
);

-- Serving and listing only ever read committed rows, so the partial indexes
-- carry that predicate rather than indexing work nobody does.
CREATE INDEX idx_attachments_item ON attachments(item_id, id)
  WHERE item_id IS NOT NULL AND state = 'committed';
CREATE INDEX idx_attachments_comment ON attachments(comment_id, id)
  WHERE comment_id IS NOT NULL AND state = 'committed';
CREATE INDEX idx_attachments_pending ON attachments(created_at, id)
  WHERE state = 'pending';
CREATE INDEX idx_attachments_created_by ON attachments(created_by);

-- Durable blob-deletion queue. An attachment row can disappear through a
-- delete, through an item delete, or through a comment cascade, and in every
-- case the object behind it must be removed too. The trigger below records the
-- key inside the same transaction that removed the row, so a crash between the
-- two cannot orphan bytes silently; a maintenance pass drains the queue.
CREATE TABLE blob_deletions (
  storage_key TEXT PRIMARY KEY,
  enqueued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TRIGGER attachments_enqueue_blob_deletion
AFTER DELETE ON attachments
BEGIN
  INSERT INTO blob_deletions (storage_key, enqueued_at)
  VALUES (OLD.storage_key, COALESCE(OLD.committed_at, OLD.created_at))
  ON CONFLICT(storage_key) DO NOTHING;
END;
