// Task 17: backup, restore, and doctor.
//
// Backup uses SQLite's VACUUM INTO, which produces a consistent, compact
// snapshot even while the source database is live and WAL-backed — a naive
// file copy could tear across WAL frames. Restore validates the candidate
// file before touching anything and refuses to overwrite an existing
// database without an explicit --force.
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, copyFileSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { Database as SqliteDatabase } from "bun:sqlite";
import { databaseFilePath, initializeDatabase } from "../db/database";
import { currentSchemaVersion } from "../db/migrate";
import { migrations } from "../db/schema";
import { findRunningServePid, servePidFilePath } from "./serve-lock";

const SQLITE_HEADER = "SQLite format 3\0";
const REQUIRED_TABLES = [
  "participants",
  "items",
  "comments",
  "mentions",
  "labels",
  "item_labels",
  "api_tokens",
  "history",
] as const;

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

// --- Backup -------------------------------------------------------------------

export function defaultBackupPath(dataDir: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(dataDir, "backups", `workboard-${stamp}.db`);
}

export function backupDatabase(db: Database, outputPath: string): string {
  if (existsSync(outputPath)) {
    throw new Error(`backup target already exists: ${outputPath}`);
  }
  mkdirSync(join(outputPath, ".."), { recursive: true });
  // VACUUM INTO writes a fully consistent snapshot; it fails if the target
  // exists, which we have already checked.
  db.run("VACUUM INTO ?", [outputPath]);
  return outputPath;
}

// --- Restore ------------------------------------------------------------------

export interface BackupValidation {
  readonly ok: boolean;
  readonly reason?: string;
  readonly schemaVersion?: number;
}

export function validateBackupFile(path: string): BackupValidation {
  if (!existsSync(path)) return { ok: false, reason: `no such file: ${path}` };
  const size = statSync(path).size;
  if (size < 100) return { ok: false, reason: "file is too small to be a SQLite database" };

  const header = Buffer.alloc(SQLITE_HEADER.length);
  const fd = openSync(path, "r");
  try {
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString("latin1") !== SQLITE_HEADER) {
      return { ok: false, reason: "not a SQLite database (bad header)" };
    }
  } finally {
    closeSync(fd);
  }

  let probe: SqliteDatabase;
  try {
    probe = new SqliteDatabase(path, { readonly: true });
  } catch (error) {
    return { ok: false, reason: `cannot open as SQLite: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const integrity = probe.query("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity?.integrity_check !== "ok") {
      return { ok: false, reason: `integrity check failed: ${integrity?.integrity_check ?? "unknown"}` };
    }
    for (const table of REQUIRED_TABLES) {
      const row = probe.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (row === null) return { ok: false, reason: `missing required table: ${table}` };
    }
    const version = currentSchemaVersion(probe);
    if (version < 1 || version > migrations.length) {
      return { ok: false, reason: `unsupported schema version ${version}` };
    }
    return { ok: true, schemaVersion: version };
  } finally {
    probe.close();
  }
}

export function restoreDatabase(dataDir: string, backupPath: string, options: { force?: boolean } = {}): void {
  const validation = validateBackupFile(backupPath);
  if (!validation.ok) throw new Error(`refusing to restore: ${validation.reason}`);

  const target = databaseFilePath(dataDir);
  if (existsSync(target) && statSync(target).size > 0 && options.force !== true) {
    throw new Error(`target database already exists at ${target}; pass --force to overwrite`);
  }
  // A live serve holds the database open: overwriting the file under it leaves
  // the server writing to the unlinked WAL and corrupting the restored image.
  // --force means "overwrite an existing database", never "corrupt a live one".
  const runningServe = findRunningServePid(dataDir);
  if (runningServe !== null) {
    throw new Error(
      `refusing to restore: a workboard serve (pid ${runningServe}) holds ${dataDir} open — stop it first, ` +
        `or remove ${servePidFilePath(dataDir)} if that PID is stale`,
    );
  }

  mkdirSync(dataDir, { recursive: true });
  // Stale WAL/SHM files from the previous database would corrupt the restored
  // file on open; remove them before swapping in the backup.
  rmSync(`${target}-wal`, { force: true });
  rmSync(`${target}-shm`, { force: true });
  copyFileSync(backupPath, target);

  // Open through the normal init path: proves the restore and re-runs any
  // pending migrations the backup may predate.
  const db = initializeDatabase(dataDir);
  db.close();
}

// --- Doctor -------------------------------------------------------------------

export interface DoctorOptions {
  readonly host?: string;
  readonly port?: number;
}

export function runDoctor(dataDir: string, options: DoctorOptions = {}): { healthy: boolean; checks: CheckResult[] } {
  const checks: CheckResult[] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  // 1. Data directory exists and is writable.
  let db: SqliteDatabase | null = null;
  try {
    mkdirSync(dataDir, { recursive: true });
    accessSync(dataDir, constants.W_OK);
    record("data directory", true, `${dataDir} is writable`);
  } catch (error) {
    record("data directory", false, `${dataDir}: ${error instanceof Error ? error.message : String(error)}`);
    return { healthy: false, checks };
  }

  // 2. Database opens and passes integrity_check.
  try {
    db = initializeDatabase(dataDir);
    const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
    record("database integrity", integrity?.integrity_check === "ok", `integrity_check: ${integrity?.integrity_check ?? "unknown"}`);
  } catch (error) {
    record("database integrity", false, `open failed: ${error instanceof Error ? error.message : String(error)}`);
    return { healthy: false, checks };
  }

  try {
    const asserted = db as SqliteDatabase;

    // 3. Migration version matches this executable.
    const version = currentSchemaVersion(asserted);
    const versionOk = version === migrations.length;
    record(
      "schema version",
      versionOk,
      versionOk ? `v${version} (current)` : `database v${version}, executable supports v${migrations.length}`,
    );

    // 4. Foreign-key check reports no violations.
    const violations = asserted.query("PRAGMA foreign_key_check").all() as unknown[];
    record("foreign keys", violations.length === 0, `${violations.length} violation(s)`);

    // 5. Entity counts without leaking secrets.
    const participants = asserted.query("SELECT COUNT(*) AS n FROM participants").get() as { n: number };
    const tokens = asserted.query("SELECT COUNT(*) AS n FROM api_tokens").get() as { n: number };
    const items = asserted.query("SELECT COUNT(*) AS n FROM items").get() as { n: number };
    record(
      "content counts",
      true,
      `${items.n} item(s), ${participants.n} participant(s), ${tokens.n} token(s) (digests only, never plaintext)`,
    );
  } finally {
    db.close();
  }

  // 6. Host/port availability (informational: busy is expected while serve runs).
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8765;
  let server: { stop(closeActive: boolean): void } | null = null;
  try {
    server = Bun.listen({ hostname: host, port, socket: {} });
    record("port availability", true, `${host}:${port} is available`);
  } catch {
    record("port availability", true, `${host}:${port} is in use (expected while serve is running)`);
  } finally {
    if (server) server.stop(true);
  }

  return { healthy: checks.every((check) => check.ok), checks };
}
