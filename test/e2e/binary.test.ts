// Task 18/19 end-to-end: exercises the compiled single binary from a clean
// directory — the runtime must not depend on source files or node_modules.
// Skips automatically when dist/workboard has not been built (bun run build).
//
// Phase A adds the generated browser bundle to the same run: the executable
// serves the fixed asset paths, proves the Preact marker is compiled in, and
// still exposes the exact six-tool MCP contract.
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
      const shellHtml = await shell.text();
      expect(shellHtml).toContain("/assets/app.js");
      expect(shellHtml).toContain('id="preact-marker" hidden');

      // Phase A fixes the public asset surface at exactly these four paths;
      // each is compiled into the binary, so a missing one breaks the UI at
      // runtime with no build error.
      const assets = await Promise.all(
        ["/", "/index.html", "/assets/app.js", "/assets/styles.css"].map(
          async (path) => ({ path, response: await fetch(`${baseUrl}${path}`) }),
        ),
      );
      for (const { path, response } of assets) {
        expect(response.status, path).toBe(200);
        expect((await response.text()).length, path).toBeGreaterThan(0);
      }

      // The former per-module asset URLs are gone: they must not survive as
      // ghost routes now that one bundle serves the whole UI.
      for (const path of ["/assets/api.js", "/assets/ui-state.js", "/assets/views.js", "/assets/board.js"]) {
        expect((await fetch(`${baseUrl}${path}`)).status, path).toBe(404);
      }

      const bundle = await fetch(`${baseUrl}/assets/app.js`);
      expect(bundle.headers.get("content-type")).toContain("text/javascript");
      const bundleSource = await bundle.text();
      // Phase A marker rendered by src/web/main.tsx, compiled into the bundle.
      expect(bundleSource).toContain("Preact browser build active");
      expect(bundleSource).toContain("preact-marker");
      expect(bundleSource).toContain("phase-a");
      // Legacy application behavior still ships inside the same bundle.
      expect(bundleSource).toContain("live-indicator");
      expect(bundleSource).toContain("api/events");

      const styles = await fetch(`${baseUrl}/assets/styles.css`);
      expect(styles.headers.get("content-type")).toContain("text/css");
      const stylesSource = await styles.text();
      expect(stylesSource.length).toBeGreaterThan(0);
      expect(stylesSource).toContain(".live-indicator");

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
      // Exact contract, not a subset: the binary advertises the six tools and
      // nothing else, so a missing or accidentally extra tool fails here.
      expect(toolsBody.result.tools.map((tool) => tool.name).sort()).toEqual([
        "comment",
        "create_work",
        "get_work",
        "list_work",
        "my_work",
        "update_work",
      ]);
      expect(toolsBody.result.tools.length).toBe(6);

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
