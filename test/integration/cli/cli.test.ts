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
      const token = await runInDir(dataDir, ["token", "--for", "local"]);
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
