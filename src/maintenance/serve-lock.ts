// Cooperative PID lock for `workboard serve`. SQLite happily supports several
// connections, but `restore --force` must never run while a serve holds the
// database open (its cached pages and the unlinked WAL would corrupt the
// restored file), so restore needs a reliable way to discover a live server.
// A PID file with liveness probing is that signal; a stale file (crash) is
// detected by checking whether the recorded PID is still alive.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  } catch {
    return false;
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

/**
 * Records this serve's PID. If another live serve is already recorded, its PID
 * is returned so the caller can warn (double-serving one data directory is
 * allowed but discouraged); the file then records the latest server so restore
 * can find whichever is still running.
 */
export function claimServePid(dataDir: string, pid: number): number | null {
  const path = servePidFilePath(dataDir);
  const existing = findRunningServePid(dataDir);
  writeFileSync(path, `${pid}\n`);
  return existing !== null && existing !== pid ? existing : null;
}

/** Removes the PID file only if it still records our own PID. */
export function releaseServePid(dataDir: string, pid: number): void {
  const path = servePidFilePath(dataDir);
  if (readPid(path) === pid) rmSync(path, { force: true });
}
