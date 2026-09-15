// Task 18/19 end-to-end: exercises the compiled single binary from a clean
// directory — the runtime must not depend on source files or node_modules.
// Skips automatically when dist/workboard has not been built (bun run build).
//
// Phase B adds the Preact shell and semantic token layer to the same run: the
// executable serves the fixed asset paths, the bundle carries the shell
// (branding, primary navigation, sign-out, live status), the stylesheet carries
// the --wb-* tokens, and the binary still exposes the exact six-tool MCP
// contract.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BINARY = join(import.meta.dir, "..", "..", "dist", "workboard");

// Markers of the Phase A placeholder shell that Phase B replaced. None may
// survive in the compiled bundle or the served document.
const PHASE_A_MARKERS = ["preact-marker", "phase-a", "Preact browser build active"] as const;

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
      // The document is only the application host plus the two fixed bundles.
      expect(shellHtml.match(/<div\b[^>]*id="app"/g)?.length).toBe(1);
      expect(shellHtml).toContain('src="/assets/app.js"');
      expect(shellHtml).toContain('href="/assets/styles.css"');
      expect(shellHtml.match(/<script\b/g)?.length).toBe(1);
      expect(shellHtml).toContain("<title>Workboard</title>");
      const shellReferences = [...shellHtml.matchAll(/(?:href|src)="([^"]*)"/g)].map((match) => match[1]!);
      expect(shellReferences.filter((value) => !value.startsWith("data:")).sort()).toEqual([
        "/assets/app.js",
        "/assets/styles.css",
      ]);
      for (const value of shellReferences) {
        expect(value, "remote reference").not.toMatch(/^(https?:)?\/\//);
      }
      for (const marker of PHASE_A_MARKERS) {
        expect(shellHtml, marker).not.toContain(marker);
      }

      // The public asset surface stays fixed at exactly these four paths; each
      // is compiled into the binary, so a missing one breaks the UI at runtime
      // with no build error.
      const assets = await Promise.all(
        ["/", "/index.html", "/assets/app.js", "/assets/styles.css"].map(
          async (path) => ({ path, response: await fetch(`${baseUrl}${path}`) }),
        ),
      );
      for (const { path, response } of assets) {
        expect(response.status, path).toBe(200);
        expect((await response.text()).length, path).toBeGreaterThan(0);
      }
      // Only those four: no other path serves anything, and in particular the
      // legacy module URLs are gone rather than surviving as ghost routes.
      for (const path of [
        "/assets/api.js",
        "/assets/ui-state.js",
        "/assets/views.js",
        "/assets/legacy-bridge.js",
        "/assets/shell/AppShell.js",
        "/assets/board.js",
        "/assets/list.js",
        "/assets/detail.js",
        "/app.js",
        "/assets/app.js.map",
      ]) {
        expect((await fetch(`${baseUrl}${path}`)).status, path).toBe(404);
      }

      const bundle = await fetch(`${baseUrl}/assets/app.js`);
      expect(bundle.headers.get("content-type")).toContain("text/javascript");
      const bundleSource = await bundle.text();
      // Phase B: the Preact application shell is compiled in — branding, the
      // labeled primary navigation, sign-out, and the live status indicator.
      expect(bundleSource).toContain("Workboard");
      expect(bundleSource).toContain("Workboard home");
      expect(bundleSource).toContain("Primary navigation");
      expect(bundleSource).toContain("Sign out");
      expect(bundleSource).toContain("live-indicator");
      // It renders into the single #app host, and the live feed is the REST
      // event stream with the token kept in browser storage.
      expect(bundleSource).toContain("Workboard application host is missing");
      expect(bundleSource).toContain("api/events");
      expect(bundleSource).toContain("localStorage");
      expect(bundleSource).toContain("sessionStorage");
      // The Phase A placeholder shell is gone, and the old side-effectful app.js
      // shell is not the live shell.
      for (const marker of PHASE_A_MARKERS) {
        expect(bundleSource, marker).not.toContain(marker);
      }
      expect(bundleSource).not.toContain("app.replaceChildren");
      expect(bundleSource).not.toContain("function renderShell");
      // Exactly one live transport: the fetch-based SSE client. EventSource
      // cannot carry the bearer header and WebSocket was never part of this
      // design.
      expect(bundleSource).not.toContain("EventSource");
      expect(bundleSource).not.toContain("WebSocket");

      const styles = await fetch(`${baseUrl}/assets/styles.css`);
      expect(styles.headers.get("content-type")).toContain("text/css");
      const stylesSource = await styles.text();
      expect(stylesSource.length).toBeGreaterThan(0);
      // One CSS bundle: everything is concatenated in, so the page makes no
      // second stylesheet request.
      expect(stylesSource).not.toContain("@import");
      // The semantic --wb-* token contract, dark mode, reduced motion, and
      // visible keyboard focus all compiled in.
      expect(stylesSource).toContain("--wb-color-canvas-default:");
      expect(stylesSource).toContain("--wb-color-focus-outline:");
      expect(stylesSource).toContain("--wb-control-medium:");
      expect(stylesSource).toContain("@media (prefers-color-scheme:dark)");
      expect(stylesSource).toContain("@media (prefers-reduced-motion:reduce)");
      expect(stylesSource).toContain(":focus-visible");
      // Legacy selectors still coexist with the token layer.
      expect(stylesSource).toContain(".live-indicator");
      expect(stylesSource).toContain("--canvas-default:var(--wb-color-canvas-default)");

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
