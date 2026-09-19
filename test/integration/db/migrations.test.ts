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
        expect(currentSchemaVersion(db)).toBe(2);
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
        ]) {
          expect(tables).toContain(expected);
        }
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
        expect(currentSchemaVersion(db)).toBe(2);
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
        expect(currentSchemaVersion(second)).toBe(2);
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
