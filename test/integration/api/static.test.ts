// Static web shell tests, updated for the Phase A generated browser bundle.
//
// The shell is no longer a set of hand-written modules served one file at a
// time: `scripts/build-web.ts` bundles `src/web/main.tsx` (Preact + the legacy
// app modules) into exactly two artifacts, and `src/web/static-assets.ts` is
// the single asset table the server embeds. This suite imports that same table
// rather than restating it, so a path that exists only in the source tree can
// never look "served" here.
//
// What is still asserted, in the same spirit as the original Task 12 suite:
// traversal-proof path matching, exact content types, and the legacy
// Workboard behavior surviving inside the bundle.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "../../../src/db/database";
import { WorkboardService } from "../../../src/app/workboard";
import { WorkboardEventBroker } from "../../../src/app/events";
import { authenticate } from "../../../src/auth/service";
import { createApiHandler } from "../../../src/api/app";
import type { StaticAsset } from "../../../src/api/app";
// The production asset table (not a copy of it): this is what `cli.ts` hands
// to createApiHandler for the real `serve` command.
import { STATIC_ASSETS } from "../../../src/web/static-assets";

const HTML_TYPE = "text/html; charset=utf-8";
const JS_TYPE = "text/javascript; charset=utf-8";
const CSS_TYPE = "text/css; charset=utf-8";

// Phase A fixes the public surface at exactly these four paths. Anything else
// under /assets/ — including the pre-bundle module URLs — must be a 404, so a
// stale index.html cannot quietly keep working against a missing file.
const EXPECTED_PATHS = ["/", "/index.html", "/assets/app.js", "/assets/styles.css"] as const;

const LEGACY_MODULE_PATHS = [
  "/assets/api.js",
  "/assets/views.js",
  "/assets/ui-state.js",
  "/assets/board.js",
  "/assets/list.js",
  "/assets/detail.js",
  "/assets/app.js.map",
  "/assets/ui-state.js.map",
] as const;

function startWithAssets(assets: Record<string, StaticAsset>): { url: string; stop(): void } {
  const dir = mkdtempSync(join(tmpdir(), "wb-static-"));
  const db = initializeDatabase(dir);
  const service = new WorkboardService(db);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createApiHandler({
      service,
      broker: new WorkboardEventBroker(),
      authenticate: (credential, now) => authenticate(db, credential, now),
      staticAssets: assets,
    }),
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function startWithStatic(): { url: string; stop(): void } {
  return startWithAssets({ ...STATIC_ASSETS });
}

describe("static web shell", () => {
  test("declares exactly the four fixed Phase A paths", () => {
    expect(Object.keys(STATIC_ASSETS).sort()).toEqual([...EXPECTED_PATHS].sort());
    for (const path of EXPECTED_PATHS) {
      const asset = STATIC_ASSETS[path];
      expect(asset, path).toBeDefined();
      expect(asset?.body.length, path).toBeGreaterThan(0);
    }
    expect(STATIC_ASSETS["/assets/app.js"]?.contentType).toBe(JS_TYPE);
    expect(STATIC_ASSETS["/assets/styles.css"]?.contentType).toBe(CSS_TYPE);
    expect(STATIC_ASSETS["/"]?.contentType).toBe(HTML_TYPE);
  });

  test("serves the shell with correct content types and no-cache", async () => {
    const server = startWithStatic();
    try {
      const index = await fetch(`${server.url}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      // The shell is regenerable per build, so it must never be cached hard.
      expect(index.headers.get("cache-control")).toBe("no-cache");
      const servedIndex = await index.text();
      // index.html is the bundle's own entry document: it must reference the
      // two fixed asset paths and host the Preact marker.
      expect(servedIndex).toContain('href="/assets/styles.css"');
      expect(servedIndex).toContain('src="/assets/app.js"');
      expect(servedIndex).toContain('id="preact-marker" hidden');
      expect(servedIndex).toContain("<title>Workboard</title>");

      const js = await fetch(`${server.url}/assets/app.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toContain("text/javascript");
      expect(js.headers.get("cache-control")).toBe("no-cache");
      const servedAppJs = await js.text();
      // Phase A proof: the marker main.tsx renders is compiled into the bundle.
      expect(servedAppJs).toContain("Preact browser build active");
      expect(servedAppJs).toContain("preact-marker");
      expect(servedAppJs).toContain("phase-a");
      // The legacy Workboard UI is bundled alongside it, not replaced.
      expect(servedAppJs).toContain("Workboard");
      expect(servedAppJs).toContain("Workboard home");
      expect(servedAppJs).toContain("live-indicator");
      expect(servedAppJs).toContain("api/events");
      expect(servedAppJs).toContain("localStorage");
      expect(servedAppJs).toContain("sessionStorage");
      // Served verbatim: the asset is the embedded string, not a re-render.
      expect(servedAppJs).toBe(STATIC_ASSETS["/assets/app.js"]!.body);

      const css = await fetch(`${server.url}/assets/styles.css`);
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toContain("text/css");
      expect(css.headers.get("cache-control")).toBe("no-cache");
      const servedCss = await css.text();
      expect(servedCss.length).toBeGreaterThan(0);
      // Base tokens and the live indicator survived the browser build.
      expect(servedCss).toContain(".live-indicator");
      expect(servedCss).toContain("--canvas-default");
      expect(servedCss).toBe(STATIC_ASSETS["/assets/styles.css"]!.body);
    } finally {
      server.stop();
    }
  });

  test("serves every declared asset, and only those", async () => {
    const server = startWithStatic();
    try {
      for (const [path, asset] of Object.entries(STATIC_ASSETS)) {
        const response = await fetch(`${server.url}${path}`);
        expect(response.status, path).toBe(200);
        expect(response.headers.get("content-type"), path).toBe(asset.contentType);
        expect(await response.text(), path).toBe(asset.body);
      }
      for (const path of ["/assets/nope.js", "/assets/", "/assets", "/index.htm"]) {
        expect((await fetch(`${server.url}${path}`)).status, path).toBe(404);
      }
    } finally {
      server.stop();
    }
  });

  test("former legacy module asset URLs are 404s", async () => {
    const server = startWithStatic();
    try {
      for (const path of LEGACY_MODULE_PATHS) {
        const response = await fetch(`${server.url}${path}`);
        expect(response.status, path).toBe(404);
        // No content-type leak for a path this server never serves.
        expect(response.headers.get("content-type") ?? "", path).not.toContain("javascript");
      }
    } finally {
      server.stop();
    }
  });

  test("unknown and traversal paths are 404s, never file reads", async () => {
    const server = startWithStatic();
    try {
      for (const path of ["/nope", "/../package.json", "/%2e%2e/package.json", "/assets/../../../package.json", "/index.html/extra"]) {
        const response = await fetch(`${server.url}${path}`);
        expect(response.status, path).toBe(404);
      }
    } finally {
      server.stop();
    }
  });

  test("API, SSE, and MCP keep working alongside static assets", async () => {
    const server = startWithStatic();
    try {
      const health = await fetch(`${server.url}/api/health`);
      expect(health.status).toBe(200);
      // The SSE route stays a real route: it answers 401 (auth) rather than
      // being replaced by an asset, and it does not hang.
      const events = await fetch(`${server.url}/api/events`);
      expect(events.status).toBe(401);
      const mcp = await fetch(`${server.url}/mcp`, { method: "GET" });
      expect(mcp.status).toBe(405);
      const api404 = await fetch(`${server.url}/api/nope`);
      expect(api404.status).toBe(404);
    } finally {
      server.stop();
    }
  });

  test("a hostile static map cannot shadow reserved routes", async () => {
    // Worst case: an asset table that claims every reserved path. The handler
    // must dispatch MCP, /api/, and /healthz before it ever consults the table,
    // so those routes answer as themselves and no shadowed body escapes.
    const hostile: Record<string, StaticAsset> = {
      ...STATIC_ASSETS,
      "/api/health": { body: "shadowed", contentType: "text/plain" },
      "/api/events": { body: "shadowed", contentType: "text/plain" },
      "/api/items": { body: "shadowed", contentType: "text/plain" },
      "/mcp": { body: "shadowed", contentType: "text/plain" },
      "/healthz": { body: "shadowed", contentType: "text/plain" },
    };
    const server = startWithAssets(hostile);
    try {
      const health = await fetch(`${server.url}/api/health`);
      expect(health.status).toBe(200);
      expect(health.headers.get("content-type")).toContain("application/json");
      expect(await health.text()).not.toContain("shadowed");

      const events = await fetch(`${server.url}/api/events`);
      expect(events.status).toBe(401);
      expect(await events.text()).not.toContain("shadowed");

      const items = await fetch(`${server.url}/api/items`);
      expect(items.status).toBe(401);
      expect(await items.text()).not.toContain("shadowed");

      const mcp = await fetch(`${server.url}/mcp`, { method: "GET" });
      expect(mcp.status).toBe(405);
      expect(await mcp.text()).not.toContain("shadowed");

      const healthz = await fetch(`${server.url}/healthz`);
      expect(healthz.status).toBe(404);
      expect(healthz.headers.get("content-type")).toContain("application/json");
      expect(await healthz.text()).not.toContain("shadowed");
    } finally {
      server.stop();
    }
  });
});
