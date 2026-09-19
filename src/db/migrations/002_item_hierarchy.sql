ALTER TABLE items ADD COLUMN parent_id INTEGER REFERENCES items(id) ON DELETE SET NULL;

CREATE INDEX idx_items_parent ON items(parent_id, status, updated_at DESC, id DESC);

CREATE TRIGGER items_parent_not_self_insert
BEFORE INSERT ON items
WHEN NEW.parent_id = NEW.id
BEGIN
  SELECT RAISE(ABORT, 'an item cannot be its own parent');
END;

CREATE TRIGGER items_parent_not_self_update
BEFORE UPDATE OF parent_id ON items
WHEN NEW.parent_id = NEW.id
BEGIN
  SELECT RAISE(ABORT, 'an item cannot be its own parent');
END;

CREATE TRIGGER items_parent_no_cycle
BEFORE UPDATE OF parent_id ON items
WHEN NEW.parent_id IS NOT NULL
BEGIN
  WITH RECURSIVE ancestors(id) AS (
    SELECT NEW.parent_id
    UNION ALL
    SELECT items.parent_id
    FROM items JOIN ancestors ON items.id = ancestors.id
    WHERE items.parent_id IS NOT NULL
  )
  SELECT CASE WHEN EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id)
    THEN RAISE(ABORT, 'item hierarchy cannot contain a cycle')
  END;
END;
