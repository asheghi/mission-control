// Task 17 acceptance: backup → restore round-trip preserves public data,
// corrupt backups fail safely, restore refuses overwrites without --force,
// and doctor exit codes distinguish healthy from unhealthy databases.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../../src/cli";
import { initializeDatabase } from "../../../src/db/database";
import { WorkboardService } from "../../../src/app/workboard";
import { LOCAL_ACTOR_BOOTSTRAP } from "../../../src/app/local-actor";
import { claimServePid, findRunningServePid, releaseServePid, servePidFilePath } from "../../../src/maintenance/serve-lock";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "wb-maint-"));
}

async function run(args: string[], dataDir?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const full = dataDir !== undefined ? ["--dir", dataDir, ...args] : args;
  const chunks: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts: unknown[]) => chunks.push(parts.join(" "));
  console.error = (...parts: unknown[]) => chunks.push(parts.join(" "));
  try {
    const code = await runCli(full);
    return { code, stdout: chunks.join("\n"), stderr: chunks.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function publicItems(dataDir: string): string {
  const db = initializeDatabase(dataDir);
  try {
    const service = new WorkboardService(db);
    return JSON.stringify(service.listItems(LOCAL_ACTOR_BOOTSTRAP, {}).items);
  } finally {
    db.close();
  }
}

describe("backup and restore", () => {
  test("backup then restore into a new directory preserves public data", async () => {
    const source = makeDir();
    const target = makeDir();
    const backup = join(makeDir(), "snap.db");
    try {
      await run(["init"], source);
      await run(["add", "Alpha", "--body", "first"], source);
      await run(["add", "Beta", "--priority", "1"], source);
      await run(["comment", "1", "note on alpha"], source);
      await run(["update", "2", "--status", "doing"], source);

      const backupRun = await run(["backup", "--output", backup], source);
      expect(backupRun.code).toBe(0);
      expect(existsSync(backup)).toBe(true);

      // Restore into the fresh directory (its init happens via restore).
      const restoreRun = await run(["restore", "--input", backup], target);
      expect(restoreRun.code).toBe(0);

      expect(publicItems(target)).toBe(publicItems(source));
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
      rmSync(join(backup, ".."), { recursive: true, force: true });
    }
  }, 20_000);

  test("corrupted backup fails safely and leaves the target untouched", async () => {
    const source = makeDir();
    const target = makeDir();
    const backup = join(makeDir(), "broken.db");
    try {
      await run(["init"], source);
      await run(["add", "Keep me"], source);
      await run(["init"], target);
      await run(["add", "Target original"], target);
      const before = publicItems(target);

      writeFileSync(backup, Buffer.from("this is not a sqlite database at all, just noise".repeat(10), "utf8"));
      const restoreRun = await run(["restore", "--input", backup], target);
      expect(restoreRun.code).not.toBe(0);
      expect(publicItems(target)).toBe(before);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
      rmSync(join(backup, ".."), { recursive: true, force: true });
    }
  }, 20_000);

  test("restore refuses to overwrite without --force, succeeds with it", async () => {
    const source = makeDir();
    const target = makeDir();
    const backup = join(makeDir(), "snap.db");
    try {
      await run(["init"], source);
      await run(["add", "From backup"], source);
      await run(["backup", "--output", backup], source);

      await run(["init"], target);
      await run(["add", "Existing data"], target);

      const refused = await run(["restore", "--input", backup], target);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("--force");
      expect(publicItems(target)).not.toBe(publicItems(source));

      const forced = await run(["restore", "--input", backup, "--force"], target);
      expect(forced.code).toBe(0);
      expect(publicItems(target)).toBe(publicItems(source));
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
      rmSync(join(backup, ".."), { recursive: true, force: true });
    }
  }, 20_000);

  test("restore refuses while a live serve holds the data directory, even with --force", async () => {
    const source = makeDir();
    const target = makeDir();
    const backup = join(makeDir(), "snap.db");
    try {
      await run(["init"], source);
      await run(["add", "From backup"], source);
      await run(["backup", "--output", backup], source);

      await run(["init"], target);
      await run(["add", "Existing data"], target);

      // Simulate a live server by recording this (alive) test process PID.
      writeFileSync(servePidFilePath(target), `${process.pid}\n`);

      const refused = await run(["restore", "--input", backup, "--force"], target);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("serve");
      expect(refused.stderr).toContain(String(process.pid));
      expect(publicItems(target)).not.toBe(publicItems(source));
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
      rmSync(join(backup, ".."), { recursive: true, force: true });
    }
  }, 20_000);
});

describe("serve pid lock", () => {
  test("claim, discover, and release follow liveness and ownership rules", () => {
    const dir = makeDir();
    try {
      expect(findRunningServePid(dir)).toBeNull();
      expect(claimServePid(dir, process.pid)).toBeNull();
      expect(findRunningServePid(dir)).toBe(process.pid);

      // Re-claiming with our own PID is a no-op: no *other* server to report.
      expect(claimServePid(dir, process.pid)).toBeNull();

      // A genuinely different live server is reported to the caller.
      const child = Bun.spawn(["sleep", "5"]);
      try {
        expect(claimServePid(dir, child.pid)).toBe(process.pid);
        expect(findRunningServePid(dir)).toBe(child.pid);
      } finally {
        child.kill();
      }

      // A file with unparseable content is not a discoverable server.
      writeFileSync(servePidFilePath(dir), "not-a-pid\n");
      expect(findRunningServePid(dir)).toBeNull();

      // Release removes the file only when it still records our own PID.
      writeFileSync(servePidFilePath(dir), `${process.pid}\n`);
      releaseServePid(dir, process.pid);
      expect(existsSync(servePidFilePath(dir))).toBe(false);
      releaseServePid(dir, process.pid); // no-op when already gone
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("doctor", () => {
  test("healthy database exits 0 with checks printed", async () => {
    const dir = makeDir();
    try {
      await run(["init"], dir);
      await run(["add", "Doctor bait"], dir);
      const result = await run(["doctor", "--port", "8791"], dir);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("[ok] database integrity");
      expect(result.stdout).toContain("[ok] schema version");
      expect(result.stdout).toContain("[ok] foreign keys");
      expect(result.stdout).toContain("healthy");
      // Counts never leak secrets: no wb_ token material in output.
      expect(result.stdout).not.toContain("wb_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("corrupted database exits non-zero", async () => {
    const dir = makeDir();
    try {
      mkdirDbJunk(dir);
      const result = await run(["doctor"], dir);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain("[FAIL]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

function mkdirDbJunk(dir: string): void {
  // A healthy database with page data trashed: the header still says SQLite
  // (so it opens) but integrity_check must fail. An all-zero file would just
  // look like an empty database to SQLite.
  mkdirSync(dir, { recursive: true });
  const db = initializeDatabase(dir);
  db.close();
  const seed = new Uint8Array(readFileSync(join(dir, "workboard.sqlite")));
  const junk = Buffer.from("CORRUPTED!!".repeat(200), "utf8");
  junk.copy(seed, 2048);
  writeFileSync(join(dir, "workboard.sqlite"), seed);
}
