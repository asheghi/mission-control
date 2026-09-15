// Static web shell tests, updated for the Phase B Preact shell and semantic
// token contract.
//
// The public surface is unchanged from Phase A: `scripts/build-web.ts` bundles
// `src/web/main.tsx` (Preact plus the legacy board/list/detail feature modules)
// into exactly two artifacts, and `src/web/static-assets.ts` is the single asset
// table the server embeds. This suite imports that same table rather than
// restating it, so a path that exists only in the source tree can never look
// "served" here.
//
// What changed for Phase B: the shell is now the top-level Preact application
// (branding, primary navigation, sign-out, live status), the Phase A marker is
// gone, and the stylesheet carries the `--wb-*` semantic token layer. The old
// side-effectful `src/web/app.js` shell still exists in the source tree for the
// legacy modules' compatibility re-exports, but it must not be reachable as a
// page script of its own.
//
// What is still asserted, in the same spirit as the original Task 12 suite:
// traversal-proof path matching, exact content types, the reserved-route
// dispatch order, and Workboard branding surviving inside the bundle.
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

// The public surface stays fixed at exactly these four paths. Anything else
// under /assets/ — including the pre-bundle module URLs — must be a 404, so a
// stale index.html cannot quietly keep working against a missing file.
const EXPECTED_PATHS = ["/", "/index.html", "/assets/app.js", "/assets/styles.css"] as const;

// Source-tree module URLs that must never be served as their own asset: one
// bundle serves the whole UI, and the legacy shell must not be reachable as an
// independently loadable page script.
const LEGACY_MODULE_PATHS = [
  "/assets/api.js",
  "/assets/views.js",
  "/assets/ui-state.js",
  "/assets/legacy-bridge.js",
  "/assets/shell/AppShell.js",
  "/assets/shell/LegacyView.js",
  "/assets/board.js",
  "/assets/list.js",
  "/assets/detail.js",
  "/assets/app.js.map",
  "/assets/ui-state.js.map",
] as const;

// Markers of the Phase A placeholder shell that Phase B replaced. None of them
// may survive in the served bundle or document.
const PHASE_A_MARKERS = ["preact-marker", "phase-a", "Preact browser build active"] as const;

/** Marker strings, matched literally rather than as regular expressions. */
function contains(haystack: string, needle: string): boolean {
  return haystack.includes(needle);
}

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

/**
 * Every `href`/`src` in the entry document, in order. Inline `data:` favicons
 * are included here so the caller can assert they are the only non-path
 * reference; they are inline documents, not network fetches.
 */
function referencedPaths(html: string): string[] {
  const paths: string[] = [];
  for (const match of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
    const value = match[1]!;
    if (value !== "") paths.push(value);
  }
  return paths;
}

describe("static web shell", () => {
  test("declares exactly the four fixed public paths", () => {
    expect(Object.keys(STATIC_ASSETS).sort()).toEqual([...EXPECTED_PATHS].sort());
    for (const path of EXPECTED_PATHS) {
      const asset = STATIC_ASSETS[path];
      expect(asset, path).toBeDefined();
      expect(asset?.body.length, path).toBeGreaterThan(0);
    }
    expect(STATIC_ASSETS["/assets/app.js"]?.contentType).toBe(JS_TYPE);
    expect(STATIC_ASSETS["/assets/styles.css"]?.contentType).toBe(CSS_TYPE);
    expect(STATIC_ASSETS["/"]?.contentType).toBe(HTML_TYPE);
    // One document, served at two paths: the table must not drift into two
    // different shells.
    expect(STATIC_ASSETS["/index.html"]?.body).toBe(STATIC_ASSETS["/"]!.body);
  });

  test("the entry document is only #app plus fixed same-origin bundles", () => {
    const html = STATIC_ASSETS["/"]!.body;

    // Exactly one application host, and the Preact shell mounts into it.
    expect(html.match(/<div\b[^>]*id="app"/g)?.length).toBe(1);
    expect(html).toContain('id="app"');
    // The document is a shell, not a rendered page: no pre-baked markup and no
    // placeholder host from the Phase A marker build.
    expect(html).not.toContain("preact-marker");
    expect(html).not.toContain("phase-a");
    expect(html).toContain("<title>Workboard</title>");

    // Every href/src is a fixed path — no third-party origin and no
    // per-deploy hashed filename the server could not serve. The one inline
    // reference is the favicon's data: URL, which is an inline document with no
    // network fetch at all.
    const references = referencedPaths(html);
    const networkPaths = references.filter((value) => !value.startsWith("data:"));
    expect(networkPaths.sort()).toEqual([
      "/assets/app.js",
      "/assets/styles.css",
    ]);
    expect(html).toContain('src="/assets/app.js"');
    expect(html).toContain('href="/assets/styles.css"');
    // No reference to a remote origin, in path or protocol-relative form.
    for (const value of networkPaths) {
      expect(value, "non-absolute or remote reference").toStartWith("/");
      expect(value, "protocol-relative reference").not.toStartWith("//");
    }
    // No remote fetch of any kind. The favicon's data: URL does contain the SVG
    // XML namespace URI, which is an identifier and not a request target, so
    // this checks the reference attributes rather than the raw text.
    for (const value of references) {
      expect(value, "remote reference").not.toMatch(/^(https?:)?\/\//);
    }
    // A single script and a single stylesheet; no inline code or style.
    expect(html.match(/<script\b/g)?.length).toBe(1);
    expect(html.match(/<link\b[^>]*rel="stylesheet"/g)?.length).toBe(1);
    expect(html).not.toContain("<style");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
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
      expect(servedIndex).toContain('id="app"');
      expect(servedIndex).toContain('src="/assets/app.js"');
      expect(servedIndex).toContain('href="/assets/styles.css"');
      // Served verbatim: the asset is the embedded string, not a re-render.
      expect(servedIndex).toBe(STATIC_ASSETS["/"]!.body);

      const js = await fetch(`${server.url}/assets/app.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toContain("text/javascript");
      expect(js.headers.get("cache-control")).toBe("no-cache");
      const servedAppJs = await js.text();

      // Phase B: the Preact application shell is compiled in — branding, the
      // labeled primary navigation, sign-out, and the live status indicator.
      expect(servedAppJs).toContain("Workboard");
      expect(servedAppJs).toContain("Workboard home");
      expect(servedAppJs).toContain("Primary navigation");
      expect(servedAppJs).toContain("Sign out");
      expect(servedAppJs).toContain("live-indicator");
      // The shell is a Preact render into the single host element.
      expect(servedAppJs).toContain("getElementById");
      expect(servedAppJs).toContain("Workboard application host is missing");
      // Live updates still come from the REST event stream, and the token
      // survives restarts through browser storage.
      expect(servedAppJs).toContain("api/events");
      expect(servedAppJs).toContain("localStorage");
      expect(servedAppJs).toContain("sessionStorage");
      expect(servedAppJs).toContain("workboard.token");

      // The Phase A placeholder shell is gone.
      for (const marker of PHASE_A_MARKERS) {
        expect(servedAppJs, marker).not.toContain(marker);
      }
      // The old side-effectful app.js shell does not ship as the live shell:
      // its store assignments, top-level render entry point, and hashchange
      // bootstrap are all absent from the bundle.
      expect(servedAppJs).not.toContain("app.replaceChildren");
      expect(servedAppJs).not.toContain("function renderShell");
      expect(servedAppJs).not.toContain("renderLogin");
      expect(servedAppJs).not.toContain('addEventListener("hashchange",render');

      // Exactly one live transport, and it is the fetch-based SSE client:
      // a browser-native EventSource cannot carry the bearer header, and a
      // WebSocket transport was never part of this design.
      expect(servedAppJs).not.toContain("EventSource");
      expect(servedAppJs).not.toContain("WebSocket");

      // Served verbatim: the asset is the embedded string, not a re-render.
      expect(servedAppJs).toBe(STATIC_ASSETS["/assets/app.js"]!.body);

      const css = await fetch(`${server.url}/assets/styles.css`);
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toContain("text/css");
      expect(css.headers.get("cache-control")).toBe("no-cache");
      const servedCss = await css.text();
      expect(servedCss.length).toBeGreaterThan(0);
      expect(servedCss).toBe(STATIC_ASSETS["/assets/styles.css"]!.body);
      // Exactly one stylesheet bundle: everything the page needs is already
      // concatenated in, so the browser makes no second CSS request.
      expect(servedCss).not.toContain("@import");
      expect(servedCss).toContain("--wb-color-canvas-default:");
    } finally {
      server.stop();
    }
  });

  test("the served stylesheet is the semantic --wb-* token contract", () => {
    const css = STATIC_ASSETS["/assets/styles.css"]!.body;
    // The browser build minifies, so media features and declaration values lose
    // their optional whitespace (`(prefers-color-scheme:dark)`, `--x:var(--y)`).
    // Match the minified form and never depend on cosmetic spacing.
    const containsToken = (token: string): boolean => contains(css, token);

    // Canvas, focus, and control tokens are the theming contract components
    // consume instead of hard-coded theme values. Each is *defined*, not merely
    // referenced: a value of `var(--...)` after the colon would mean the token
    // layer is missing and every component silently falls back.
    for (const token of [
      "--wb-color-canvas-default",
      "--wb-color-canvas-subtle",
      "--wb-color-canvas-inset",
      "--wb-color-focus-outline",
      "--wb-control-medium",
    ]) {
      expect(containsToken(`${token}:`), `${token} is not defined`).toBe(true);
    }
    expect(css).toMatch(/--wb-color-canvas-default:(?!var\()/);
    expect(css).toMatch(/--wb-color-focus-outline:(?!var\()/);
    expect(css).toMatch(/--wb-control-medium:(?!var\()/);
    // A control height is a real length, not an empty or inherited value.
    expect(css).toMatch(/--wb-control-medium:\s*\d/);

    // One bundle carries the whole stylesheet: no @import survives to fetch a
    // second same-origin (or third-party) file at runtime.
    expect(css).not.toContain("@import");
  });

  test("the stylesheet carries dark mode, reduced motion, and focus behavior", () => {
    const css = STATIC_ASSETS["/assets/styles.css"]!.body;

    // Theme integration overrides tokens rather than component selectors.
    expect(css).toContain("color-scheme:light dark");
    expect(css).toContain("@media (prefers-color-scheme:dark)");
    // The dark block re-declares the semantic tokens; it must not simply repeat
    // the light values under a component selector.
    const darkBlock = css.slice(css.indexOf("@media (prefers-color-scheme:dark)"));
    expect(darkBlock).toMatch(/--wb-color-canvas-default:(?!var\()/);
    expect(darkBlock).toMatch(/--wb-color-focus-outline:(?!var\()/);
    // The dark canvas is a different value from the light one, so the override
    // is a real theme and not a copy of the default block.
    const lightCanvas = css.match(/--wb-color-canvas-default:([^;}]+)/)?.[1];
    const darkCanvas = darkBlock.match(/--wb-color-canvas-default:([^;}]+)/)?.[1];
    expect(lightCanvas).toBeDefined();
    expect(darkCanvas).toBeDefined();
    expect(darkCanvas).not.toBe(lightCanvas);

    // Motion is opt-out: transitions and animations collapse when the user asks
    // for reduced motion.
    const motionIndex = css.indexOf("@media (prefers-reduced-motion:reduce)");
    expect(motionIndex).toBeGreaterThanOrEqual(0);
    const motionBlock = css.slice(motionIndex);
    expect(motionBlock).toContain("transition-duration");
    expect(motionBlock).toContain("animation-duration");
    expect(motionBlock).toContain("!important");

    // Keyboard focus stays visible on both layers: the tokenized base layer and
    // the legacy feature layer that has not migrated yet. Minification splits
    // the comma-separated legacy selector into separate rules, so count rules
    // rather than expecting one exact string.
    expect(css).toContain(":focus-visible");
    expect((css.match(/:focus-visible/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(css).toContain("outline:2px solid var(--wb-color-focus-outline)");
  });

  test("legacy selectors coexist with the semantic token layer", () => {
    const css = STATIC_ASSETS["/assets/styles.css"]!.body;

    // The not-yet-migrated board/list/detail selectors keep working because the
    // compatibility aliases still resolve to the semantic tokens.
    expect(css).toContain(".live-indicator");
    expect(css).toContain(".board-card");
    expect(css).toContain(".list-table");
    expect(css).toMatch(/--canvas-default:var\(--wb-color-canvas-default\)/);
    expect(css).toMatch(/--focus-outline:var\(--wb-color-focus-outline\)/);
    // Those aliases are actually consumed: a rule still paints through them.
    expect(css).toContain("var(--canvas-default)");
    expect(css).toContain("var(--focus-outline)");
    // The alias block is a mapping, not a second source of truth: every entry
    // resolves to a --wb-* token and none hard-codes a colour of its own.
    const aliasStart = css.indexOf("--base-white:");
    const aliasBlock = css.slice(aliasStart, css.indexOf("}", aliasStart));
    expect(aliasBlock).toContain("--canvas-default:var(--wb-color-canvas-default)");
    expect(aliasBlock).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    for (const declaration of aliasBlock.split(";")) {
      if (declaration.trim() === "") continue;
      expect(declaration, declaration).toContain("var(--wb-");
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

  test("the legacy app.js shell is not reachable as its own page script", async () => {
    const server = startWithStatic();
    try {
      // No path other than the single bundle name serves JavaScript.
      for (const path of ["/app.js", "/assets/app.js.map", "/assets/main.js", "/assets/main.tsx"]) {
        const response = await fetch(`${server.url}${path}`);
        expect(response.status, path).toBe(404);
      }

      // Only the bundle name serves script, and the bundle is the Preact
      // entrypoint: it renders into #app and never loads a second script.
      const bundle = await fetch(`${server.url}/assets/app.js`);
      const source = await bundle.text();
      expect(source).toContain("Workboard application host is missing");
      expect(source).not.toContain("preact-marker");
      // The old shell's top-level bootstrap (a bare `render()` call at module
      // scope with a hashchange listener) is not the bundle's entrypoint.
      expect(source).not.toContain("app.replaceChildren");
      expect(source).not.toContain("function renderShell");

      // And the entry document has no second script tag that could load it.
      const html = STATIC_ASSETS["/"]!.body;
      const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]!);
      expect(scripts).toEqual(["/assets/app.js"]);
    } finally {
      server.stop();
    }
  });

  test("the bundle carries no EventSource or WebSocket transport", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;

    expect(js).not.toContain("EventSource");
    expect(js).not.toContain("WebSocket");
    // The live feed is the fetch-stream SSE client with the bearer header.
    expect(js).toContain("api/events");
    expect(js).toContain("text/event-stream");
    expect(js).toContain("Authorization");
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
