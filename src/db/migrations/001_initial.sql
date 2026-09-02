CREATE TABLE participants (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('human', 'agent')),
  avatar_color TEXT NOT NULL CHECK(avatar_color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  created_at TEXT NOT NULL
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'doing', 'blocked', 'done')),
  priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 0 AND 3),
  assignee_id INTEGER REFERENCES participants(id) ON DELETE SET NULL,
  created_by INTEGER NOT NULL REFERENCES participants(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES participants(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE mentions (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  color TEXT NOT NULL CHECK(color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  created_at TEXT NOT NULL
);

CREATE TABLE item_labels (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY(item_id, label_id)
);

CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  secret_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE history (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES participants(id),
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_items_status_updated ON items(status, updated_at DESC, id DESC);
CREATE INDEX idx_items_assignee_status ON items(assignee_id, status, updated_at DESC, id DESC);
CREATE INDEX idx_comments_item_time ON comments(item_id, created_at, id);
CREATE INDEX idx_mentions_participant_item ON mentions(participant_id, item_id);
CREATE UNIQUE INDEX idx_mentions_item_body_unique ON mentions(item_id, participant_id) WHERE comment_id IS NULL;
CREATE UNIQUE INDEX idx_mentions_comment_unique ON mentions(comment_id, participant_id) WHERE comment_id IS NOT NULL;
CREATE INDEX idx_labels_name ON labels(name COLLATE NOCASE);
CREATE INDEX idx_history_item_time ON history(item_id, created_at, id);
CREATE INDEX idx_api_tokens_digest ON api_tokens(secret_digest);
CREATE INDEX idx_api_tokens_prefix ON api_tokens(token_prefix);
