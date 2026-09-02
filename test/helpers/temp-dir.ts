import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { initializeDatabase } from "../../src/db/database";

/** Runs `fn` with a fresh temporary directory, removed afterwards. */
export function withTempDataDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "workboard-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Runs `fn` with a freshly migrated database in a temporary directory.
 * The connection is closed BEFORE the directory is removed — deleting the
 * directory (including the -wal/-shm files) under an open connection corrupts
 * the WAL view.
 */
export function withTempDatabase<T>(fn: (db: Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "workboard-test-"));
  const db = initializeDatabase(dir);
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
