import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { InternalError } from "../domain/errors";
import { migrate } from "./migrate";
import { migrations } from "./schema";

const DATABASE_FILE_NAME = "workboard.sqlite";
const BUSY_TIMEOUT_MS = 5000;

export function databaseFilePath(dataDir: string): string {
  return join(dataDir, DATABASE_FILE_NAME);
}

export function openDatabase(dataDir: string): Database {
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    throw new InternalError(`Failed to create data directory ${dataDir}.`, { cause: error });
  }

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
