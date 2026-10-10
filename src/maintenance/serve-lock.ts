// Kernel-owned cooperative locks for serve and restore. Metadata is diagnostic,
// not proof of ownership: flock is released even on SIGKILL or a machine reboot.
// NEVER unlink these files: contenders must always lock the same stable inode.
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, ftruncateSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { join } from "node:path";

export const PID_LOCK_ERROR = -1;
const LOCK_EX_NB = 2 | 4;
let flock: ((fd: number, operation: number) => number) | undefined;

export function loadFlock(load: (library: string) => (fd: number, operation: number) => number): (fd: number, operation: number) => number {
  // Bun's FFI ships in the compiled binary; no helper process or dependency.
  // Fail closed on unsupported platforms, never fall back to a PID-only lock.
  const muslArch = ({ x64: "x86_64", arm64: "aarch64", arm: "armhf", ia32: "i386", riscv64: "riscv64" } as Record<string, string>)[process.arch] ?? process.arch;
  const libraries = process.platform === "linux" ? ["libc.so.6", "libc.so", `/lib/ld-musl-${muslArch}.so.1`]
    : process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"] : [];
  // Runtime-only musl installations may expose only the dynamic loader, which
  // is also libc; development installations additionally provide libc.so.
  for (const library of libraries) {
    try {
      return load(library);
    } catch { /* Try the next libc; never fall back to PID-only ownership. */ }
  }
  throw new Error("cannot load flock: Workboard requires Linux or macOS libc");
}

function tryLock(fd: number): boolean {
  flock ??= loadFlock((library) => dlopen(library, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  }).symbols.flock);
  return flock(fd, LOCK_EX_NB) === 0;
}

export interface LockInfo {
  readonly version: 1;
  readonly kind: "serve" | "restore";
  readonly pid: number;
  readonly dataDir: string;
  readonly startedAt: number;
  readonly hostname?: string;
  readonly port?: number;
  readonly appUrl?: string;
}

interface HeldLock {
  readonly fd: number;
  info: LockInfo;
}
const held = new Map<string, HeldLock>();

export function servePidFilePath(dataDir: string): string {
  return join(dataDir, "workboard.pid");
}

export function restoreLockPath(dataDir: string): string {
  return join(dataDir, "workboard.restore.lock");
}

function canonicalPath(dataDir: string, kind: LockInfo["kind"]): string {
  return join(realpathSync(dataDir), kind === "serve" ? "workboard.pid" : "workboard.restore.lock");
}

function readInfo(path: string): LockInfo | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo> | null;
    if (value === null || value.version !== 1 || (value.kind !== "serve" && value.kind !== "restore") ||
      !Number.isInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.dataDir !== "string" ||
      typeof value.startedAt !== "number") return null;
    return value as LockInfo;
  } catch {
    return null;
  }
}

// Compatibility with the previous bare-PID format. Do not overwrite an older
// live server's marker. Dead or malformed legacy markers are upgraded in place.
// Stop old-version servers before upgrading; old clients cannot read JSON locks.
function legacyHolder(path: string): number | null {
  let raw: string;
  try { raw = readFileSync(path, "utf8").trim(); } catch { return null; }
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? null : pid;
  }
}

function writeInfo(lock: HeldLock): void {
  // Only the flock owner writes. Readers encountering a partial write fail
  // closed if the inode is locked, rather than mistaking it for an idle board.
  ftruncateSync(lock.fd, 0);
  const bytes = Buffer.from(`${JSON.stringify(lock.info)}\n`);
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(lock.fd, bytes, written, bytes.length - written, written);
  }
}

// Serialize brief probes with acquisition, not with the lifetime of an owner.
// Otherwise discovery's temporary flock can masquerade as a real owner. This
// stable gate inode is never removed; a crash releases it just like the main lock.
function enterGate(path: string): number {
  const fd = openSync(`${path}.gate`, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    // A stopped probe must not strand every future startup in blocking FFI.
    // Keep the public synchronous API, but yield the CPU between nonblocking
    // attempts and fail closed after a bounded, monotonic deadline.
    const deadline = performance.now() + 1_000;
    while (!tryLock(fd)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("timed out acquiring lock coordination gate");
      Bun.sleepSync(Math.min(5, remaining));
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function claim(dataDir: string, kind: LockInfo["kind"], endpoint?: { hostname: string; port: number }): number | null {
  let gate: number | undefined;
  let fd: number | undefined;
  try {
    const path = canonicalPath(dataDir, kind);
    const existing = held.get(path);
    if (existing !== undefined) return existing.info.pid;
    gate = enterGate(path);
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    if (!tryLock(fd)) return readInfo(path)?.pid ?? PID_LOCK_ERROR;
    const legacy = legacyHolder(path);
    if (legacy !== null) return legacy;
    const lock: HeldLock = {
      fd,
      info: { version: 1, kind, pid: process.pid, dataDir: realpathSync(dataDir), startedAt: Date.now(), ...endpoint },
    };
    writeInfo(lock);
    held.set(path, lock);
    fd = undefined; // Ownership transferred to held; close only on release.
    return null;
  } catch {
    return PID_LOCK_ERROR;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (gate !== undefined) closeSync(gate);
  }
}

function discover(dataDir: string, kind: LockInfo["kind"]): number | null {
  let gate: number | undefined;
  let fd: number | undefined;
  try {
    const path = canonicalPath(dataDir, kind);
    const ours = held.get(path);
    if (ours !== undefined) return ours.info.pid;
    gate = enterGate(path);
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    if (!tryLock(fd)) return readInfo(path)?.pid ?? PID_LOCK_ERROR;
    // An unlocked JSON file is stale, even if its PID has been reused.
    return legacyHolder(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : PID_LOCK_ERROR;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (gate !== undefined) closeSync(gate);
  }
}

function release(dataDir: string, kind: LockInfo["kind"]): void {
  const path = canonicalPath(dataDir, kind);
  const lock = held.get(path);
  if (lock === undefined) return;
  try {
    // Keep the inode, but clear diagnostic metadata on clean shutdown.
    ftruncateSync(lock.fd, 0);
  } finally {
    held.delete(path);
    closeSync(lock.fd);
  }
}

/** null = acquired, positive PID = occupied, -1 = unavailable/unknown owner. */
export function claimServePid(dataDir: string, pid: number, endpoint?: { hostname: string; port: number }): number | null {
  // The OS lock belongs to this process, not an arbitrary PID supplied by callers.
  if (pid !== process.pid) return PID_LOCK_ERROR;
  return claim(dataDir, "serve", endpoint);
}

/** Publish the actual endpoint after binding (especially important for port 0). */
export function updateServeInfo(dataDir: string, endpoint: { hostname: string; port: number; appUrl: string }): void {
  const lock = held.get(canonicalPath(dataDir, "serve"));
  if (lock === undefined) throw new Error("cannot publish server info without holding the serve lock");
  lock.info = { ...lock.info, ...endpoint };
  writeInfo(lock);
}

export function findRunningServePid(dataDir: string): number | null {
  return discover(dataDir, "serve");
}

/** Metadata is returned only when a live lock still matches its recorded PID. */
export function findRunningServeInfo(dataDir: string): LockInfo | null {
  const pid = findRunningServePid(dataDir);
  if (pid === null || pid === PID_LOCK_ERROR) return null;
  const info = readInfo(servePidFilePath(dataDir));
  return info?.kind === "serve" && info.pid === pid ? info : null;
}

export function releaseServePid(dataDir: string, pid: number): void {
  if (pid === process.pid) release(dataDir, "serve");
}

export function claimRestoreLock(dataDir: string): number | null {
  return claim(dataDir, "restore");
}

export function releaseRestoreLock(dataDir: string): void {
  release(dataDir, "restore");
}

export function findRestoreHolder(dataDir: string): number | null {
  return discover(dataDir, "restore");
}

/** Ownership comes from our held descriptor, never from diagnostic JSON. */
export function ownsRestoreLock(dataDir: string): boolean {
  return held.has(canonicalPath(dataDir, "restore"));
}
