// Cooperative PID lock for `workboard serve`. SQLite happily supports several
// connections, but `restore --force` must never run while a serve holds the
// database open (its cached pages and the unlinked WAL would corrupt the
// restored file), so restore needs a reliable way to discover a live server.
// A PID file with liveness probing is that signal; a stale file (crash) is
// detected by checking whether the recorded PID is still alive.
import { existsSync, linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function servePidFilePath(dataDir: string): string {
  return join(dataDir, "workboard.pid");
}

function readPid(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the one definitive "no such process" result. EPERM means the
    // process exists but belongs to another user or namespace; treating that as
    // dead would let restore run underneath a live server on a shared board.
    return !(typeof error === "object" && error !== null && (error as { code?: string }).code === "ESRCH");
  }
}

/** Returns the PID of a live serve for this data directory, if discoverable. */
export function findRunningServePid(dataDir: string): number | null {
  const path = servePidFilePath(dataDir);
  if (!existsSync(path)) return null;
  const pid = readPid(path);
  if (pid === null || !pidIsAlive(pid)) return null;
  return pid;
}

export const PID_LOCK_ERROR = -1;
export const PID_LOCK_STALE = -2;

/**
 * Exclusively records this serve's PID.
 *
 * Two servers cannot safely share one data directory: a single overwriteable
 * PID file loses the older holder and lets restore replace its open database.
 * The populated temporary inode plus hard link makes publication atomic — a
 * contender sees either no marker or a complete PID, never an empty file.
 */
export function claimServePid(dataDir: string, pid: number): number | null {
  const path = servePidFilePath(dataDir);
  const claim = publishPidAtomically(path, pid);
  if (claim === "acquired") return null;
  if (claim === "error") return PID_LOCK_ERROR;
  const holder = readPid(path);
  if (holder !== null && pidIsAlive(holder)) return holder;
  // Reaping an abandoned marker automatically is itself racy: another process
  // can publish a fresh marker between a stale read and unlink. Refuse with a
  // distinct result so the operator can remove the named stale marker safely.
  return PID_LOCK_STALE;
}

/** Removes the PID file only if it still records our own PID. */
export function releaseServePid(dataDir: string, pid: number): void {
  const path = servePidFilePath(dataDir);
  if (readPid(path) === pid) rmSync(path, { force: true });
}

// --- Restore lock -------------------------------------------------------------

/**
 * Path of the restore-in-progress marker.
 *
 * Distinct from the serve PID file, which is advisory by design: `serve`
 * overwrites it and carries on, because two servers on one data directory is
 * discouraged rather than forbidden. A restore cannot tolerate that — replacing
 * the database under a server that started mid-restore is exactly the corruption
 * the preflight check exists to prevent, and the check alone cannot see a server
 * that starts after it runs.
 */
export function restoreLockPath(dataDir: string): string {
  return join(dataDir, "workboard.restore.lock");
}

/**
 * Take the restore lock, or report who holds it.
 *
 * Creation is exclusive at the filesystem boundary: a read-then-write check is
 * not a lock because two restore processes can both read "absent" before either
 * writes. A fully populated inode is linked into place atomically instead. A
 * live holder never expires by age — a large remote restore may legitimately
 * run for hours, and letting another process take over mid-copy would corrupt
 * the board.
 */
export function claimRestoreLock(dataDir: string): number | null {
  const path = restoreLockPath(dataDir);
  const claim = publishPidAtomically(path, process.pid);
  if (claim === "acquired") return null;
  if (claim === "error") return PID_LOCK_ERROR;
  const holder = readPid(path);
  if (holder !== null && pidIsAlive(holder)) return holder;
  // See claimServePid: automatic stale reaping cannot be made atomic with lock
  // acquisition using portable filesystem primitives. Refusal is safer than two
  // restores both believing they own the board.
  return PID_LOCK_STALE;
}

/** Release the restore lock if we still hold it. */
export function releaseRestoreLock(dataDir: string): void {
  const path = restoreLockPath(dataDir);
  if (readPid(path) === process.pid) rmSync(path, { force: true });
}

/** Whether a restore is currently in progress for this data directory. */
export function findRestoreHolder(dataDir: string): number | null {
  const holder = readPid(restoreLockPath(dataDir));
  return holder !== null && pidIsAlive(holder) ? holder : null;
}

type PidPublication = "acquired" | "exists" | "error";

/** Publish a complete PID file with an atomic, no-replace hard link. */
function publishPidAtomically(path: string, pid: number): PidPublication {
  const temp = `${path}.claim-${pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temp, `${pid}\n`, { flag: "wx" });
    try {
      linkSync(temp, path);
      return "acquired";
    } catch (error) {
      return isAlreadyExists(error) ? "exists" : "error";
    }
  } catch {
    return "error";
  } finally {
    rmSync(temp, { force: true });
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EEXIST";
}
