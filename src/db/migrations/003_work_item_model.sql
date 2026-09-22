-- Migration 003: work-item model.
--
-- This model replaces the pre-deployment item shape, so every item-domain row
-- is deleted here on purpose: items and their comments, mentions, label
-- assignments, and history. Participants, labels, API tokens, and
-- authentication settings are preserved. The delete is explicit (not a DROP)
-- so the ON DELETE CASCADE foreign keys stay authoritative.

DELETE FROM items;

ALTER TABLE items ADD COLUMN work_item_type TEXT NOT NULL DEFAULT 'user_story'
  CHECK(work_item_type IN ('feature', 'user_story', 'bug', 'task'));
ALTER TABLE items ADD COLUMN backlog_position INTEGER NOT NULL DEFAULT 0
  CHECK(backlog_position >= 0);

CREATE INDEX idx_items_backlog_order ON items(status, parent_id, backlog_position, id);
CREATE INDEX idx_items_type ON items(work_item_type, status, updated_at DESC, id DESC);

-- A Task is always a child: it needs a parent at insert time and it can never
-- be detached afterwards. The table reads are deterministic without ORDER BY.
CREATE TRIGGER items_task_requires_parent_insert
BEFORE INSERT ON items
WHEN NEW.work_item_type = 'task' AND NEW.parent_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a task requires a parent item');
END;

CREATE TRIGGER items_task_requires_parent_update
BEFORE UPDATE OF parent_id, work_item_type ON items
WHEN NEW.work_item_type = 'task' AND NEW.parent_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a task requires a parent item');
END;

-- Deleting an item that still has children is rejected; children must be
-- reparented or deleted first. This runs inside the DELETE and blocks the row
-- removal even when the child's own foreign key would have nulled parent_id.
CREATE TRIGGER items_no_delete_with_children
BEFORE DELETE ON items
WHEN EXISTS (SELECT 1 FROM items WHERE parent_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'an item with children cannot be deleted');
END;

-- Typed links between items. Kinds are stored in one direction:
--   related    — symmetric, stored once (source_item_id < target_item_id)
--   dependency — directional, source is the predecessor of target
--   duplicate  — directional, source duplicates target
CREATE TABLE item_links (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('related', 'dependency', 'duplicate')),
  source_item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  target_item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES participants(id),
  created_at TEXT NOT NULL,
  CHECK(source_item_id <> target_item_id),
  CHECK(kind <> 'related' OR source_item_id < target_item_id)
);

CREATE UNIQUE INDEX idx_item_links_pair ON item_links(kind, source_item_id, target_item_id);
CREATE INDEX idx_item_links_source ON item_links(source_item_id, kind, id);
CREATE INDEX idx_item_links_target ON item_links(target_item_id, kind, id);
-- An item can duplicate at most one original.
CREATE UNIQUE INDEX idx_item_links_duplicate_source
  ON item_links(source_item_id) WHERE kind = 'duplicate';
