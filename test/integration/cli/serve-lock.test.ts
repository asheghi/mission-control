import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimRestoreLock, claimServePid, findRestoreHolder, findRunningServeInfo, loadFlock,
  findRunningServePid, PID_LOCK_ERROR, releaseRestoreLock, releaseServePid,
  restoreLockPath, servePidFilePath,
} from "../../../src/maintenance/serve-lock";
import { backupDatabase, preflightRestore } from "../../../src/maintenance/backup";
import { initializeDatabase } from "../../../src/db/database";

const lockModule = join(import.meta.dir, "../../../src/maintenance/serve-lock.ts");
const cliModule = join(import.meta.dir, "../../../src/cli.ts");
const entry = join(import.meta.dir, "../../../src/entry.ts");

function makeDir(): string { return mkdtempSync(join(tmpdir(), "wb-native-lock-")); }

// Hold ownership until the parent closes stdin or kills us. No timing-based
// sleeps: reading the acknowledgement proves the child's lock is established.
function spawnHolder(dir: string, kind: "serve" | "restore") {
  const script = `
    import { claimServePid, claimRestoreLock } from ${JSON.stringify(lockModule)};
    const result = ${kind === "serve" ? "claimServePid" : "claimRestoreLock"}(${JSON.stringify(dir)}${kind === "serve" ? ", process.pid" : ""});
    console.log(JSON.stringify({ result, pid: process.pid }));
    await Bun.stdin.text();
  `;
  return Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

type Child = ReturnType<typeof spawnHolder>;
async function acknowledgement(child: Child): Promise<{ result: number | null; pid: number }> {
  const reader = child.stdout.getReader();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`child exited before acknowledgement: ${await new Response(child.stderr).text()}`);
      text += new TextDecoder().decode(chunk.value);
    }
    return JSON.parse(text.trim()) as { result: number | null; pid: number };
  } finally { reader.releaseLock(); }
}
const stopped = new WeakMap<Child, Promise<void>>();
function stop(child: Child): Promise<void> {
  const previous = stopped.get(child);
  if (previous !== undefined) return previous;
  const stopping = (async () => {
    child.kill("SIGKILL");
    await child.exited;
    await new Response(child.stderr).text();
  })();
  stopped.set(child, stopping);
  return stopping;
}

for (const kind of ["serve", "restore"] as const) {
  const pathFor = kind === "serve" ? servePidFilePath : restoreLockPath;
  const claim = (dir: string) => kind === "serve" ? claimServePid(dir, process.pid) : claimRestoreLock(dir);
  const discover = kind === "serve" ? findRunningServePid : findRestoreHolder;
  const release = (dir: string) => kind === "serve" ? releaseServePid(dir, process.pid) : releaseRestoreLock(dir);

  describe(`${kind} OS lock`, () => {
    test("SIGKILL releases ownership and leftover JSON needs no manual cleanup", async () => {
      const dir = makeDir();
      const child = spawnHolder(dir, kind);
      try {
        expect((await acknowledgement(child)).result).toBeNull();
        expect(discover(dir)).toBe(child.pid);
        expect(claim(dir)).toBe(child.pid);
        const inode = statSync(pathFor(dir)).ino;
        await stop(child);
        expect(JSON.parse(readFileSync(pathFor(dir), "utf8")).pid).toBe(child.pid);
        expect(discover(dir)).toBeNull();
        expect(claim(dir)).toBeNull();
        expect(statSync(pathFor(dir)).ino).toBe(inode);
        expect(discover(dir)).toBe(process.pid);
        release(dir);
        expect(statSync(pathFor(dir)).ino).toBe(inode);
        expect(discover(dir)).toBeNull();
      } finally {
        await stop(child);
        release(dir);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("competing processes admit exactly one and reject the loser without replacing metadata", async () => {
      const dir = makeDir();
      const children = [spawnHolder(dir, kind), spawnHolder(dir, kind)];
      try {
        const results = await Promise.all(children.map(acknowledgement));
        expect(results.filter((value) => value.result === null)).toHaveLength(1);
        const winner = results.find((value) => value.result === null)!;
        const loser = results.find((value) => value.result !== null)!;
        // The contender may observe the inode before its owner finishes writing
        // JSON. Unknown ownership still fails closed; it must never be admitted.
        expect([winner.pid, PID_LOCK_ERROR]).toContain(loser.result);
        expect(discover(dir)).toBe(winner.pid);
        expect(JSON.parse(readFileSync(pathFor(dir), "utf8")).pid).toBe(winner.pid);
      } finally {
        await Promise.all(children.map(stop));
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("unlocked JSON naming a reused live PID is stale; corrupt and dead legacy files recover too", () => {
      const dir = makeDir();
      try {
        for (const content of [
          JSON.stringify({ version: 1, kind, pid: process.pid, dataDir: dir, startedAt: 1 }),
          "{interrupted-json", "2147483646\n", "",
        ]) {
          writeFileSync(pathFor(dir), content);
          expect(discover(dir)).toBeNull();
          expect(claim(dir)).toBeNull();
          const info = JSON.parse(readFileSync(pathFor(dir), "utf8"));
          expect(info.kind).toBe(kind);
          expect(info.version).toBe(1);
          expect(info.pid).toBe(process.pid);
          release(dir);
        }
      } finally {
        release(dir);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a live legacy PID is protected until the old-version owner stops", () => {
      const dir = makeDir();
      try {
        writeFileSync(pathFor(dir), `${process.pid}\n`);
        expect(discover(dir)).toBe(process.pid);
        expect(claim(dir)).toBe(process.pid);
        expect(readFileSync(pathFor(dir), "utf8")).toBe(`${process.pid}\n`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test("corrupt metadata on a locked inode fails closed in another process", async () => {
      const dir = makeDir();
      const child = spawnHolder(dir, kind);
      try {
        await acknowledgement(child);
        writeFileSync(pathFor(dir), "not-json");
        expect(discover(dir)).toBe(PID_LOCK_ERROR);
        expect(claim(dir)).toBe(PID_LOCK_ERROR);
        await stop(child);
        expect(claim(dir)).toBeNull();
        release(dir);
      } finally {
        await stop(child);
        release(dir);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("concurrent discovery never creates false claim contention", async () => {
      const dir = makeDir();
      // Persistent idle inode: metadata is not evidence of ownership.
      expect(claim(dir)).toBeNull();
      release(dir);
      const script = `
        import { ${kind === "serve" ? "findRunningServePid" : "findRestoreHolder"} as discover } from ${JSON.stringify(lockModule)};
        console.log(JSON.stringify({ result: null, pid: process.pid }));
        for (let i = 0; i < 20000; i++) discover(${JSON.stringify(dir)});
      `;
      const child = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      try {
        await acknowledgement(child);
        for (let i = 0; i < 2000; i++) {
          expect(claim(dir)).toBeNull();
          release(dir);
        }
        expect(await child.exited).toBe(0);
      } finally {
        await stop(child);
        release(dir);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a suspended gate holder times out instead of hanging claims and discovery", async () => {
      const dir = makeDir();
      expect(claim(dir)).toBeNull();
      release(dir);
      const script = `
        import { dlopen, FFIType } from "bun:ffi";
        import { openSync, constants } from "node:fs";
        import { loadFlock } from ${JSON.stringify(lockModule)};
        const flock = loadFlock((library) => dlopen(library, {
          flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        }).symbols.flock);
        const fd = openSync(${JSON.stringify(`${pathFor(dir)}.gate`)}, constants.O_RDWR);
        if (flock(fd, 2 | 4) !== 0) throw new Error("cannot hold test gate");
        console.log(JSON.stringify({ result: null, pid: process.pid }));
        await Bun.stdin.text();
      `;
      const child = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      try {
        expect((await acknowledgement(child)).result).toBeNull();
        child.kill("SIGSTOP");
        for (const operation of [claim, discover]) {
          const started = performance.now();
          expect(operation(dir)).toBe(PID_LOCK_ERROR);
          expect(performance.now() - started).toBeLessThan(2_500);
        }
        await stop(child);
        expect(claim(dir)).toBeNull();
        release(dir);
        expect(discover(dir)).toBeNull();
      } finally {
        await stop(child);
        release(dir);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 10_000);

    test("symlinked directory aliases share ownership and release the same lock", () => {
      const dir = makeDir();
      const parent = makeDir();
      const alias = join(parent, "board");
      try {
        symlinkSync(dir, alias);
        expect(claim(dir)).toBeNull();
        expect(claim(alias)).toBe(process.pid);
        release(alias);
        expect(discover(dir)).toBeNull();
        expect(claim(dir)).toBeNull();
      } finally {
        release(dir);
        rmSync(parent, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

test("Linux libc loading falls back to the musl soname", () => {
  if (process.platform !== "linux") return;
  const libraries: string[] = [];
  const implementation = () => 0;
  expect(loadFlock((library) => {
    libraries.push(library);
    if (library === "libc.so.6") throw new Error("not installed");
    return implementation;
  })).toBe(implementation);
  expect(libraries).toEqual(["libc.so.6", "libc.so"]);
  const runtimeLibraries: string[] = [];
  expect(loadFlock((library) => {
    runtimeLibraries.push(library);
    if (!library.startsWith("/lib/ld-musl-")) throw new Error("not installed");
    return implementation;
  })).toBe(implementation);
  expect(runtimeLibraries).toHaveLength(3);
  expect(runtimeLibraries[2]).toMatch(/^\/lib\/ld-musl-.+\.so\.1$/);
  expect(() => loadFlock(() => { throw new Error("not installed"); })).toThrow("cannot load flock");
});

describe("serve/restore integration", () => {
  test("restore metadata naming this process does not bypass someone else's OS lock", async () => {
    const dir = makeDir();
    const db = initializeDatabase(dir);
    const backup = join(dir, "snapshot.db");
    backupDatabase(db, backup);
    db.close();
    const child = spawnHolder(dir, "restore");
    try {
      await acknowledgement(child);
      const info = JSON.parse(readFileSync(restoreLockPath(dir), "utf8"));
      writeFileSync(restoreLockPath(dir), JSON.stringify({ ...info, pid: process.pid }));
      expect(() => preflightRestore(dir, backup, { force: true })).toThrow("another restore");
    } finally {
      await stop(child);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serve refuses a held restore lock before opening the database", async () => {
    const dir = makeDir();
    const child = spawnHolder(dir, "restore");
    try {
      await acknowledgement(child);
      const serve = Bun.spawn([process.execPath, entry, "--dir", dir, "serve", "--port", "0", "--hide-token"], {
        stdout: "pipe", stderr: "pipe",
      });
      const stderr = await new Response(serve.stderr).text();
      expect(await serve.exited).not.toBe(0);
      expect(stderr).toContain("restore");
      expect(stderr).toContain(String(child.pid));
      expect(findRunningServePid(dir)).toBeNull();
    } finally {
      await stop(child);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("real server publishes actual ephemeral port and restarts after SIGKILL", async () => {
    const dir = makeDir();
    const script = `
      import { runCli } from ${JSON.stringify(cliModule)};
      import { findRunningServeInfo } from ${JSON.stringify(lockModule)};
      const serving = runCli(["--dir", ${JSON.stringify(dir)}, "serve", "--port", "0", "--hide-token"]);
      console.log(JSON.stringify({ result: null, pid: process.pid, info: findRunningServeInfo(${JSON.stringify(dir)}) }));
      process.exitCode = await serving;
    `;
    let child = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      await acknowledgement(child);
      const info = findRunningServeInfo(dir);
      expect(info?.pid).toBe(child.pid);
      expect(info?.hostname).toBe("127.0.0.1");
      expect(info?.port).toBeGreaterThan(0);
      expect(info?.appUrl).toBe(`http://127.0.0.1:${info?.port}`);
      expect(info?.startedAt).toBeGreaterThan(0);
      expect(info?.dataDir).toBe(dir);
      expect((await fetch(`${info?.appUrl}/api/health`)).ok).toBe(true);
      const contender = Bun.spawn([process.execPath, entry, "--dir", dir, "serve", "--port", "0", "--hide-token"], {
        stdout: "pipe", stderr: "pipe",
      });
      const refusal = await new Response(contender.stderr).text();
      expect(await contender.exited).not.toBe(0);
      expect(refusal).toContain("another serve");
      const inode = statSync(servePidFilePath(dir)).ino;
      await stop(child);
      expect(findRunningServeInfo(dir)).toBeNull();
      child = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      await acknowledgement(child);
      expect(findRunningServeInfo(dir)?.pid).toBe(child.pid);
      expect(statSync(servePidFilePath(dir)).ino).toBe(inode);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      expect(findRunningServePid(dir)).toBeNull();
      expect(readFileSync(servePidFilePath(dir), "utf8")).toBe("");
    } finally {
      await stop(child);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
