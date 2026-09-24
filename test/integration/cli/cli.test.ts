// Task 11 black-box tests: every CLI command runs as a real subprocess
// (bun run src/entry.ts …), verifying exit codes, human and --json output,
// and persistence through the shared data directory.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "../../../src/entry.ts");

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(args: readonly string[]): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, "run", ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

function runInDir(dataDir: string, args: readonly string[]): Promise<RunResult> {
  return run(["--data", dataDir, ...args]);
}

// Reads the serve process's stderr incrementally until the listening line
// appears, then returns the accumulated text. Reading to EOF would block
// forever because the pipe only closes when the process exits.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readServeStderr(proc: { stderr: ReadableStream<Uint8Array>; kill: (signal: number) => void }): Promise<string> {
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stderr = "";
  let pending = reader.read();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      pending,
      new Promise<"tick">((resolve) => setTimeout(() => resolve("tick"), 100)),
    ]);
    if (result === "tick") continue;
    pending = reader.read();
    if (result.done) break;
    stderr += decoder.decode(result.value ?? new Uint8Array(), { stream: true });
    if (stderr.includes("listening on http://")) break;
  }
  if (!stderr.includes("listening on http://")) {
    proc.kill(9);
    throw new Error(`serve never reported a port; stderr so far: ${stderr}`);
  }
  return stderr;
}

describe("CLI", () => {
  test("init is idempotent and seeds a default participant", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-cli-"));
    try {
      const first = await runInDir(dataDir, ["init"]);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain("Initialized workboard");

      const second = await runInDir(dataDir, ["init"]);
      expect(second.code).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("init defaults to an 'admin' human and prints its token once", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-cli-"));
    try {
      const first = await runInDir(dataDir, ["init"]);
      expect(first.code).toBe(0);
      expect(first.stderr).toContain("not shown again");
      expect(first.stdout).toMatch(/^wb_[A-Za-z0-9_-]{43}$/m);

      // Second init does not print another credential.
      const second = await runInDir(dataDir, ["init"]);
      expect(second.code).toBe(0);
      expect(second.stdout).not.toMatch(/wb_[A-Za-z0-9_-]{10}/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("init --admin names the default human; --hide-token suppresses the printed credential", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-cli-"));
    try {
      const first = await runInDir(dataDir, ["init", "--admin", "maintainer"]);
      expect(first.code).toBe(0);
      expect(first.stdout).toMatch(/^wb_[A-Za-z0-9_-]{43}$/m);

      const list = JSON.parse((await runInDir(dataDir, ["--json", "participant"])).stdout);
      expect(list.some((participant: { name: string }) => participant.name === "maintainer")).toBe(true);
      const admin = list.find((participant: { name: string }) => participant.name === "maintainer");
      expect(admin.kind).toBe("human");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }

    const hidden = mkdtempSync(join(tmpdir(), "wb-cli-"));
    try {
      const first = await runInDir(hidden, ["init", "--hide-token"]);
      expect(first.code).toBe(0);
      expect(first.stdout).not.toMatch(/wb_[A-Za-z0-9_$-]{10}/);
      expect(first.stderr).not.toContain("not shown again");

      // The credential is still issued for the admin participant; only the
      // printing is suppressed, so `token create`/`--for admin` keeps working.
      const token = await runInDir(hidden, ["token", "--for", "admin"]);
      expect(token.code).toBe(0);
      expect(token.stdout.trim()).toMatch(/^wb_[A-Za-z0-9_-]{43}$/);
    } finally {
      rmSync(hidden, { recursive: true, force: true });
    }
  });

  test("participant rename updates the participant everywhere", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-cli-"));
    try {
      await runInDir(dataDir, ["init"]);

      const renamed = JSON.parse((await runInDir(dataDir, ["--json", "participant", "rename", "admin", "--name", "bahman"])).stdout);
      expect(renamed.name).toBe("bahman");
      expect(renamed.kind).toBe("human");

      // Human mode prints the rename; listing shows the new name.
      expect((await runInDir(dataDir, ["participant", "rename", "bahman", "--name", "Lead"]))
        .stdout).toContain("Renamed participant #1 to Lead");

      // Tokens and actor resolution follow the new name case-insensitively.
      const token = await runInDir(dataDir, ["token", "--for", "lead"]);
      expect(token.code).toBe(0);

      // Conflicts fail clearly; unknown participants fail clearly too.
      const conflict = await runInDir(dataDir, ["participant", "rename", "lead", "--name", "LEAD"]);
      expect(conflict.code).toBe(0); // renaming to itself is not a conflict
      const clash = await runInDir(dataDir, ["participant", "add", "--name", "agent1"]);
      expect(clash.code).toBe(0);
      const duplicate = await runInDir(dataDir, ["participant", "rename", "agent1", "--name", "Lead"]);
      expect(duplicate.code).toBe(1);
      expect(duplicate.stderr).toContain("already exists");
      const missing = await runInDir(dataDir, ["participant", "rename", "ghost", "--name", "x"]);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("no participant named 'ghost'");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("participant rename validates the new name", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-cli-"));
    try {
      await runInDir(dataDir, ["init"]);
      const bad = await runInDir(dataDir, ["participant", "rename", "admin", "--name", "has space"]);
      expect(bad.code).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("serve prints a token-carrying fragment link; --hide-token suppresses it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-cli-"));
    try {
      await runInDir(dataDir, ["init"]);
      // A placeholder credential for the URL shape only; authentication with
      // this literal value is not exercised in this test.
      const placeholderToken = "wb_" + "A".repeat(43);
      const envProc = Bun.spawn(
        [process.execPath, "run", ENTRY, "--data", dataDir, "serve", "--port", "0"],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, WORKBOARD_TOKEN: placeholderToken } },
      );
      const envStderr = await readServeStderr(envProc);
      expect(envStderr).toContain("#token=");
      envProc.kill("SIGTERM");
      await envProc.exited;

      const flagProc = Bun.spawn(
        [process.execPath, "run", ENTRY, "--data", dataDir, "serve", "--port", "0", "--hide-token"],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, WORKBOARD_TOKEN: placeholderToken } },
      );
      const hiddenStderr = await readServeStderr(flagProc);
      expect(hiddenStderr).toContain("Web:");
      expect(hiddenStderr).not.toContain("#token=");
      flagProc.kill("SIGTERM");
      await flagProc.exited;

      // Plain serve mints its own session credential for the default human
      // participant, so the link just works. The token itself is never
      // asserted on here (only its shape marker in the URL fragment).
      const plainProc = Bun.spawn(
        [process.execPath, "run", ENTRY, "--data", dataDir, "serve", "--port", "0"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const plainStderr = await readServeStderr(plainProc);
      expect(plainStderr).toContain("Web UI:");
      expect(plainStderr).toMatch(/#token=wb_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/);
      plainProc.kill("SIGTERM");
      await plainProc.exited;
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("serve revokes its self-issued session token on shutdown", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-cli-"));
    try {
      await runInDir(dataDir, ["init"]);
      const proc = Bun.spawn(
        [process.execPath, "run", ENTRY, "--data", dataDir, "serve", "--port", "0"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const banner = await readServeStderr(proc);
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(banner);
      if (match === null) throw new Error(`no port in banner: ${banner}`);
      const url = `http://127.0.0.1:${match[1]}`;
      // The credential stays in a code variable; it is never printed here.
      const fragmentMatch = /#token=([A-Za-z0-9_-]+)/.exec(banner);
      if (fragmentMatch === null) throw new Error("no token fragment in banner");
      const sessionToken = fragmentMatch[1];

      const whileUp = await fetch(`${url}/api/labels`, { headers: { Authorization: `Bearer ${sessionToken}` } });
      expect(whileUp.status).toBe(200);

      proc.kill("SIGTERM");
      await proc.exited;
      // Direct DB check: the session token must be revoked after shutdown.
      const { Database } = await import("bun:sqlite");
      const db = new Database(join(dataDir, "workboard.sqlite"), { readonly: true });
      try {
        const rows = db.query("SELECT revoked_at FROM api_tokens WHERE name = 'serve-session'").all() as { revoked_at: string | null }[];
        expect(rows).toHaveLength(1);
        expect(rows[0]?.revoked_at).not.toBeNull();
      } finally {
        db.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("add/list/view/update/comment round-trip in --json and human modes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-cli-"));
    try {
      await runInDir(dataDir, ["init"]);

      const added = await runInDir(dataDir, ["--json", "add", "Write docs", "--priority", "1", "--body", "see @local"]);
      expect(added.code).toBe(0);
      const addedJson = JSON.parse(added.stdout);
      const itemId: number = addedJson.item.id;
      expect(addedJson.item.title).toBe("Write docs");

      const list = await runInDir(dataDir, ["--json", "list"]);
      expect(list.code).toBe(0);
      const listJson = JSON.parse(list.stdout);
      expect(listJson.items.map((entry: { id: number }) => entry.id)).toContain(itemId);
      expect(listJson.nextCursor).toBeNull();

      const humanList = await runInDir(dataDir, ["list"]);
      expect(humanList.stdout).toContain(`#${itemId} [user_story] [todo] (P1) Write docs`);
      expect(humanList.stdout).toContain("(1 item(s))");

      const updated = await runInDir(dataDir, ["--json", "update", String(itemId), "--status", "doing", "--labels", "docs"]);
      expect(updated.code).toBe(0);
      const updatedJson = JSON.parse(updated.stdout);
      expect(updatedJson.changedFields).toEqual(["status", "labels"]);

      const commented = await runInDir(dataDir, ["--json", "comment", String(itemId), "making progress"]);
      expect(commented.code).toBe(0);
      expect(JSON.parse(commented.stdout).comment.body).toBe("making progress");

      const viewed = await runInDir(dataDir, ["--json", "view", String(itemId)]);
      expect(viewed.code).toBe(0);
      const viewJson = JSON.parse(viewed.stdout);
      expect(viewJson.item.status).toBe("doing");
      expect(viewJson.item.labels.map((label: { name: string }) => label.name)).toEqual(["docs"]);
      expect(viewJson.comments).toHaveLength(1);
      expect(viewJson.history.length).toBeGreaterThanOrEqual(2);

      const humanView = await runInDir(dataDir, ["view", String(itemId)]);
      expect(humanView.stdout).toContain(`#${itemId} [user_story] [doing] (P1) Write docs`);
      expect(humanView.stdout).toContain("@local: making progress");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("unknown assignee by name fails with a clear error", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-cli-"));
    try {
      await runInDir(dataDir, ["init"]);
      const result = await runInDir(dataDir, ["add", "Test", "--assignee", "nobody"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("no participant named 'nobody'");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("invalid status is rejected with exit code 1", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-cli-"));
    try {
      await runInDir(dataDir, ["init"]);
      const added = JSON.parse((await runInDir(dataDir, ["--json", "add", "X"])).stdout);
      const result = await runInDir(dataDir, ["update", String(added.item.id), "--status", "archived"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("workboard:");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("viewing a missing item exits nonzero", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-cli-"));
    try {
      await runInDir(dataDir, ["init"]);
      const result = await runInDir(dataDir, ["view", "999"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("not found");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("token prints a usable credential once", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-cli-"));
    try {
      await runInDir(dataDir, ["init"]);
      const token = await runInDir(dataDir, ["token", "--for", "admin"]);
      expect(token.code).toBe(0);
      const plaintext = token.stdout.trim();
      expect(plaintext).toMatch(/^wb_[A-Za-z0-9_-]{43}$/);
      expect(token.stderr).toContain("not shown again");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("serve exposes REST and MCP health, then exits on SIGTERM", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-cli-"));
    try {
      await runInDir(dataDir, ["init"]);
      const proc = Bun.spawn([process.execPath, "run", ENTRY, "--data", dataDir, "serve", "--port", "0"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      // Read stderr incrementally until the listening line appears (the pipe
      // only closes when the process exits, so we must not read to EOF).
      // IMPORTANT: keep exactly one reader.read() in flight; issuing a new
      // read per timeout tick orphans earlier queued reads and the first
      // (only) chunk would resolve into a promise nobody awaits.
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let stderr = "";
      let port: number | null = null;
      let pending = reader.read();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const result = await Promise.race([
          pending,
          new Promise<"tick">((resolve) => setTimeout(() => resolve("tick"), 100)),
        ]);
        if (result === "tick") continue;
        pending = reader.read();
        if (result.done) break;
        stderr += decoder.decode(result.value ?? new Uint8Array(), { stream: true });
        const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr);
        if (match !== null) {
          port = Number(match[1]);
          break;
        }
      }
      if (port === null) {
        proc.kill("SIGKILL");
        throw new Error(`serve never reported a port; stderr so far: ${stderr}`);
      }
      expect(port).toBeGreaterThan(0);

      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(health.status).toBe(200);
      const mcpProbe = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "GET" });
      expect(mcpProbe.status).toBe(405);

      proc.kill("SIGTERM");
      const code = await proc.exited;
      expect(code).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("unknown command prints usage and exits 1", async () => {
    const result = await run(["definitely-not-a-command"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });

  test("--version prints the version and exits 0", async () => {
    const result = await run(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
  });
});
