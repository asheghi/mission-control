// Task 18/19 end-to-end: exercises the compiled single binary from a clean
// directory — the runtime must not depend on source files or node_modules.
// Skips automatically when dist/workboard has not been built (bun run build).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BINARY = join(import.meta.dir, "..", "..", "dist", "workboard");

function run(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([BINARY, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return {
    code: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe("compiled binary (bun run build first; skipped otherwise)", () => {
  test("version, participants, tokens, serve, health, web, REST, MCP", async () => {
    if (!existsSync(BINARY)) {
      console.warn("SKIP: dist/workboard not built; run `bun run build` first");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "wb-binary-"));
    const dataDir = join(dir, "wb_data");
    try {
      expect(run(["--version"], dir).stdout.trim()).toBe("0.1.0");

      const participant = run(["participant", "add", "--dir", "./wb_data", "--name", "admin", "--kind", "human"], dir);
      expect(participant.code).toBe(0);
      expect(participant.stdout).toContain("admin");

      const tokenRun = run(["token", "create", "--dir", "./wb_data", "--participant", "admin", "--name", "bootstrap"], dir);
      expect(tokenRun.code).toBe(0);
      const token = tokenRun.stdout.trim().split("\n").filter((line) => line.startsWith("wb_"))[0];
      expect(token).toStartWith("wb_");

      const doctor = run(["doctor", "--dir", "./wb_data", "--port", "8797"], dir);
      expect(doctor.code).toBe(0);
      expect(doctor.stdout).toContain("healthy");

      // serve --port 0 picks a free port; the stderr line announces the URL.
      const server = Bun.spawn([BINARY, "serve", "--dir", "./wb_data", "--port", "0"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const reader = server.stderr.getReader();
      let stderrText = "";
      const deadline = Date.now() + 10_000;
      let baseUrl: string | null = null;
      while (Date.now() < deadline && baseUrl === null) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 250)),
        ]);
        if ("value" in chunk && chunk.value !== undefined) stderrText += new TextDecoder().decode(chunk.value);
        const match = stderrText.match(/listening on (http:\/\/\S+)/);
        if (match?.[1] !== undefined) baseUrl = match[1];
        else if (chunk.done) break;
      }
      if (baseUrl === null) throw new Error(`serve never announced its URL: ${stderrText}`);
      expect(baseUrl).toStartWith("http://");

      const health = await fetch(`${baseUrl}/api/health`);
      expect(health.status).toBe(200);
      expect(((await health.json()) as { data: { status: string } }).data.status).toBe("ok");

      const shell = await fetch(`${baseUrl}/`);
      expect(shell.status).toBe(200);
      expect(await shell.text()).toContain("/assets/app.js");

      const created = await fetch(`${baseUrl}/api/items`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "From the binary" }),
      });
      expect(created.status).toBe(201);

      const tools = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(tools.status).toBe(200);
      const toolsBody = (await tools.json()) as { result: { tools: { name: string }[] } };
      expect(toolsBody.result.tools.map((tool) => tool.name)).toContain("list_work");

      // SIGTERM graceful shutdown (also required by the Task 19 matrix).
      server.kill("SIGTERM");
      await server.exited;
      expect(server.exitCode).toBe(0);
      writeFileSync(join(dir, "done"), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
