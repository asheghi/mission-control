import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { databaseFilePath, initializeDatabase, openDatabase } from "../../../src/db/database";
import { currentSchemaVersion, migrate } from "../../../src/db/migrate";
import { migrations } from "../../../src/db/schema";
import type { Migration } from "../../../src/db/schema";
import { withTempDataDir } from "../../helpers/temp-dir";

const GOOD_MIGRATION: Migration = {
  version: 1,
  name: "good",
  sql: "CREATE TABLE spike_a (id INTEGER PRIMARY KEY);",
};
const BAD_MIGRATION: Migration = {
  version: 2,
  name: "bad",
  sql: "CREATE TABLE spike_b (id INTEGER); THIS IS NOT VALID SQL;",
};
const SKIP_VERSION_MIGRATION: Migration = {
  version: 2,
  name: "skip",
  sql: "CREATE TABLE spike_c (id INTEGER);",
};
const BAD_FIRST_MIGRATION: Migration = {
  version: 1,
  name: "bad-first",
  sql: "CREATE TABLE spike_b (id INTEGER); THIS IS NOT VALID SQL;",
};

function tableNames(db: Database): string[] {
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe("openDatabase", () => {
  test("asserts required pragmas on the connection", () => {
    withTempDataDir((dir) => {
      const db = openDatabase(dir);
      try {
        expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
        expect((db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
        expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      } finally {
        db.close();
      }
    });
  });

  test("creates nested data directories and the database file", () => {
    withTempDataDir((dir) => {
      const nested = join(dir, "one", "two");
      const db = initializeDatabase(nested);
      db.close();
      expect(existsSync(databaseFilePath(nested))).toBe(true);
    });
  });
});

describe("migrate", () => {
  test("fresh create applies migration 001 with expected tables", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        expect(currentSchemaVersion(db)).toBe(3);
        const tables = tableNames(db);
        for (const expected of [
          "participants",
          "items",
          "comments",
          "mentions",
          "labels",
          "item_labels",
          "api_tokens",
          "history",
          "item_links",
        ]) {
          expect(tables).toContain(expected);
        }
      } finally {
        db.close();
      }
    });
  });

  test("migration 003 clears item data and preserves identity data", () => {
    withTempDataDir((dir) => {
      const db = openDatabase(dir);
      try {
        migrate(db, migrations.slice(0, 2));
        db.exec(`
          INSERT INTO participants (id, name, kind, avatar_color, created_at)
            VALUES (1, 'tester', 'human', '#000000', '2026-01-01T00:00:00.000Z');
          INSERT INTO labels (id, name, color, created_at)
            VALUES (1, 'kept', '#112233', '2026-01-01T00:00:00.000Z');
          INSERT INTO api_tokens (participant_id, name, token_prefix, secret_digest, created_at)
            VALUES (1, 'kept', 'prefix', 'digest', '2026-01-01T00:00:00.000Z');
          INSERT INTO items (id, title, body, status, priority, created_by, created_at, updated_at)
            VALUES (1, 'discarded', '', 'todo', 2, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
          INSERT INTO comments (item_id, author_id, body, created_at)
            VALUES (1, 1, 'discarded', '2026-01-01T00:00:00.000Z');
          INSERT INTO item_labels (item_id, label_id) VALUES (1, 1);
        `);

        migrate(db, migrations);

        expect(currentSchemaVersion(db)).toBe(3);
        expect((db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n).toBe(0);
        expect((db.query("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n).toBe(0);
        expect((db.query("SELECT COUNT(*) AS n FROM item_labels").get() as { n: number }).n).toBe(0);
        expect((db.query("SELECT COUNT(*) AS n FROM participants").get() as { n: number }).n).toBe(1);
        expect((db.query("SELECT COUNT(*) AS n FROM labels").get() as { n: number }).n).toBe(1);
        expect((db.query("SELECT COUNT(*) AS n FROM api_tokens").get() as { n: number }).n).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  test("work-item constraints require lowercase types, nonnegative positions, and Task parents", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        db.exec("INSERT INTO participants (id, name, kind, avatar_color, created_at) VALUES (1, 'tester', 'human', '#000000', '2026-01-01T00:00:00.000Z')");
        const insert = db.query(
          "INSERT INTO items (title, body, status, priority, created_by, created_at, updated_at, parent_id, work_item_type, backlog_position) VALUES (?, '', 'todo', 2, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?, ?, ?)",
        );
        insert.run("Feature", null, "feature", 0);
        expect(() => insert.run("Uppercase", null, "Feature", 0)).toThrow(/CHECK constraint/);
        expect(() => insert.run("Negative", null, "bug", -1)).toThrow(/CHECK constraint/);
        expect(() => insert.run("Orphan task", null, "task", 0)).toThrow(/requires a parent/);
        insert.run("Child task", 1, "task", 0);
        expect(() => db.query("DELETE FROM items WHERE id = 1").run()).toThrow(/with children/);
      } finally {
        db.close();
      }
    });
  });

  test("running migrations twice is a no-op", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        migrate(db, migrations);
        expect(currentSchemaVersion(db)).toBe(3);
      } finally {
        db.close();
      }
    });
  });

  test("reopen preserves data and schema version", () => {
    withTempDataDir((dir) => {
      const first = initializeDatabase(dir);
      first.exec(
        "INSERT INTO participants (name, kind, avatar_color, created_at) VALUES ('tester', 'human', '#000000', '2026-01-01T00:00:00.000Z')",
      );
      first.close();

      const second = initializeDatabase(dir);
      try {
        expect(currentSchemaVersion(second)).toBe(3);
        const row = second.query("SELECT name FROM participants WHERE name = 'tester'").get() as
          | { name: string }
          | null;
        expect(row?.name).toBe("tester");
      } finally {
        second.close();
      }
    });
  });

  test("rolls back a failed later migration and keeps prior state", () => {
    withTempDataDir((dir) => {
      const db = openDatabase(dir);
      try {
        expect(() => migrate(db, [GOOD_MIGRATION, BAD_MIGRATION])).toThrow(/rolled back/);
        expect(currentSchemaVersion(db)).toBe(1);
        expect(tableNames(db)).toContain("spike_a");
        expect(tableNames(db)).not.toContain("spike_b");
      } finally {
        db.close();
      }
    });
  });

  test("rolls back when the first migration fails, leaving version 0", () => {
    withTempDataDir((dir) => {
      const db = openDatabase(dir);
      try {
        expect(() => migrate(db, [BAD_FIRST_MIGRATION])).toThrow(/rolled back/);
        expect(currentSchemaVersion(db)).toBe(0);
        expect(tableNames(db)).not.toContain("spike_b");
      } finally {
        db.close();
      }
    });
  });

  test("rejects non-consecutive migration numbering before applying anything", () => {
    withTempDataDir((dir) => {
      const db = openDatabase(dir);
      try {
        expect(() => migrate(db, [SKIP_VERSION_MIGRATION])).toThrow(/must declare version 1/);
        expect(currentSchemaVersion(db)).toBe(0);
        expect(tableNames(db)).not.toContain("spike_c");
      } finally {
        db.close();
      }
    });
  });

  test("rejects a database newer than the executable", () => {
    withTempDataDir((dir) => {
      const db = openDatabase(dir);
      db.exec("PRAGMA user_version = 99");
      db.close();

      expect(() => initializeDatabase(dir)).toThrow(/newer than this executable/);
    });
  });
});
