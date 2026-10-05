import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InternalError } from "../domain/errors";
import { migrate } from "./migrate";
import { migrations } from "./schema";

const DATABASE_FILE_NAME = "workboard.sqlite";
const BUSY_TIMEOUT_MS = 5000;
// The data directory can also be a source checkout (dev:board). Only ignore
// Workboard's own runtime paths at its root, never the whole directory.
const DATA_GITIGNORE = [
  "# Workboard runtime data",
  "/workboard.sqlite",
  "/workboard.sqlite-wal",
  "/workboard.sqlite-shm",
  "/workboard.sqlite-journal",
  "/workboard.pid",
  "/workboard.restore.lock",
  "/workboard.storage.json",
  "/workboard.storage.json.tmp-*",
  "/blobs/",
  "",
].join("\n");

function ensureDataGitignore(dataDir: string): void {
  try {
    // Exclusive creation preserves even an empty file or a symlink, and avoids
    // a check-then-write race with another initializer or a user's editor.
    writeFileSync(join(dataDir, ".gitignore"), DATA_GITIGNORE, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw new InternalError(`Failed to create data directory .gitignore at ${dataDir}.`, { cause: error });
  }
}

export function databaseFilePath(dataDir: string): string {
  return join(dataDir, DATABASE_FILE_NAME);
}

export function openDatabase(dataDir: string): Database {
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    throw new InternalError(`Failed to create data directory ${dataDir}.`, { cause: error });
  }

  ensureDataGitignore(dataDir);

  const path = databaseFilePath(dataDir);
  let db: Database;
  try {
    db = new Database(path);
  } catch (error) {
    throw new InternalError("Failed to open the workboard database.", { cause: error });
  }
  applyConnectionPragmas(db, path);
  return db;
}

export function initializeDatabase(dataDir: string): Database {
  const db = openDatabase(dataDir);
  try {
    migrate(db, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function applyConnectionPragmas(db: Database, path: string): void {
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

    const foreignKeys = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number } | null;
    const busyTimeout = db.query("PRAGMA busy_timeout").get() as { timeout: number } | null;
    const journalMode = db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;

    if (foreignKeys?.foreign_keys !== 1) {
      throw new InternalError("The foreign_keys pragma could not be enabled.");
    }
    if (busyTimeout?.timeout !== BUSY_TIMEOUT_MS) {
      throw new InternalError("The busy_timeout pragma could not be set.");
    }
    if (journalMode === null) {
      throw new InternalError("The journal_mode pragma could not be read.");
    }
    // In-memory databases always report "memory"; file-backed ones must be WAL.
    if (path !== ":memory:" && journalMode.journal_mode !== "wal") {
      throw new InternalError("The journal_mode pragma could not be set to WAL.");
    }
  } catch (error) {
    db.close();
    if (error instanceof InternalError) throw error;
    throw new InternalError("Failed to configure the workboard database connection.", { cause: error });
  }
}
