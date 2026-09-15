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

// --- Phase C: the typed board -------------------------------------------------
//
// Phase C moves board rendering out of the legacy `src/web/board.js` module and
// into `src/web/features/board/*`, registered through the same view registry as
// a Preact component. The bundle is minified, so nothing below may depend on a
// minified identifier, a formatting choice, or a helper's internal variable
// name. Every marker is either a literal that survives minification (a class
// name, an ARIA attribute, a visible string) or a DOM API the board must call.

// Product markers of the typed board: the column structure, the card's semantic
// native anchor, the status control, and per-column quick add.
const TYPED_BOARD_MARKERS = [
  "board-column",
  "board-column-title",
  "board-cards",
  "board-card-top",
  "board-card-bottom",
  "board-card-people",
  "quick-add",
] as const;

// Markers proving the card's status control is a native form control the
// keyboard can drive, not a div with a click handler.
const TYPED_BOARD_CONTROL_MARKERS = ["aria-labelledby", "Move #", "to status", "Drop"] as const;

// The accessible-name and delegation strings the promoted card carries. These
// are the user-visible text, so they are contract, not implementation. The
// assignee label is assembled at runtime (`Assigned to ${name}, ${kind}`), so
// the minifier keeps the two halves as separate literals and the bundle is
// asserted on those halves rather than on the interpolated whole.
const TYPED_BOARD_LABEL_MARKERS = [
  "Add item to",
  "Assigned to ",
  "Unassigned",
  "1 comment",
  " comments",
] as const;

// Signatures of the legacy `src/web/board.js` module that the typed component
// replaced. These are source-level names, so they survive minification only if
// that module is actually bundled — which is exactly the regression to catch.
// The legacy board wired its drag & drop imperatively with these exact
// listener/classlist calls, and its card carried a `role="link"` + click
// navigation instead of a real anchor.
const LEGACY_BOARD_SIGNATURES = [
  'addEventListener("dragover"',
  'addEventListener("drop"',
  "classList.add(\"drop-target\")",
  'role: "link"',
  "cardNode",
  "quickAddForm",
  "renderCards",
  "changeStatus",
] as const;

// Third-party origins that must never appear in a served asset. A CDN script,
// a remote font, or an analytics beacon would all show up here.
const THIRD_PARTY_HOSTS = [
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "esm.sh",
  "skypack.dev",
  "googleapis.com",
  "gstatic.com",
  "fonts.googleapis.com",
  "reactjs.org",
  "preactjs.com",
] as const;

// Router and state-library signatures that Phase C's frozen decisions exclude:
// one hash-based shell owns routing, and board state lives in hooks.
const DISALLOWED_LIBRARY_SIGNATURES = [
  "preact-router",
  "preact/compat",
  "TanStack",
  "QueryClient",
  "createStore",
  "redux",
  "zustand",
  "mobx",
  "nanostores",
] as const;

/** Marker strings, matched literally rather than as regular expressions. */
function contains(haystack: string, needle: string): boolean {
  return haystack.includes(needle);
}

/** Total occurrences of a literal marker in a bundle. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
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

// -----------------------------------------------------------------------------
// Phase C — the typed board
//
// Phase C is a replacement, not an addition: `src/web/features/board/*` renders
// the board as a Preact component registered as `kind: "component"`, and the
// legacy `src/web/board.js` module is no longer part of the UI. Two failure
// modes are worth a test apiece, and neither is visible to a unit test:
//
//   1. The replacement silently does not ship — the bundle is built from a
//      different entrypoint, or a stale asset table is embedded — so the board
//      renders nothing and no build error is raised.
//   2. The legacy module ships *alongside* the new component, re-registering the
//      `board` view and wiring a second set of global drag listeners. Phase B's
//      acceptance explicitly allows legacy modules to coexist temporarily; Phase
//      C is where the board stops being one of them.
// -----------------------------------------------------------------------------
describe("typed board bundle (Phase C)", () => {
  test("the served bundle carries the typed board's markers", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;

    // The column structure and card chrome the product components render.
    for (const marker of TYPED_BOARD_MARKERS) {
      expect(contains(js, marker), `typed board marker missing: ${marker}`).toBe(true);
    }
    // The board still shows its four columns by their visible labels.
    for (const label of ["To do", "Doing", "Blocked", "Done"]) {
      expect(contains(js, label), `column label missing: ${label}`).toBe(true);
    }
    // The empty-column and load-failure states survive the migration.
    expect(js).toContain("No items");
    expect(js).toContain("Retry");
    expect(js).toContain("Loading board");
  });

  test("the promoted card uses a semantic native anchor and native status control", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;

    // Phase C requirement: the card title is a real anchor, so it is reachable,
    // focusable, and activatable without a synthetic role or key handler. The
    // legacy card was a `div` with `role="link"`, a tabindex, and a click
    // handler — asserted gone below.
    expect(js).toContain("board-card-title");
    expect(js).toContain("#/item/");
    expect(js).toContain("href");
    // The element types are passed to the DOM as strings, so the anchor and the
    // article wrapper survive minification as literals.
    expect(js).toContain('"a"');
    expect(js).toContain('"article"');

    // The status control is a native `<select>` with an accessible name, which
    // is what makes a keyboard-only status change possible without drag. Note
    // that a Preact bundle never contains HTML source text, so these are the
    // element-type and prop literals rather than a `<select` tag.
    expect(js).toContain("Move #");
    expect(js).toContain("to status");
    expect(js).toContain('"select"');
    expect(js).toContain('"option"');
    expect(js).toContain("onChange");
    // The keyboard alternative to dragging: the card title handles Left/Right.
    expect(js).toContain("ArrowLeft");
    expect(js).toContain("ArrowRight");
    expect(js).toContain("onKeyDown");
    expect(js).toContain("preventDefault");
  });

  test("the typed board's accessible names and delegation contract ship", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;

    for (const marker of TYPED_BOARD_LABEL_MARKERS) {
      expect(contains(js, marker), `accessible-name marker missing: ${marker}`).toBe(true);
    }

    // Quick add is labelled per column ("Add item to <column>") and guards
    // against a blank title before issuing a create.
    expect(js).toContain("Add item to");
    expect(js).toContain("trim");
    expect(js).toContain("maxLength");
    expect(js).toContain("256");

    // Drag & drop is still present, and it still reads the payload it wrote.
    // Preact's slot props keep their documented camelCase names through
    // minification, so `onDragStart`/`onDrop` are exactly the migrated handlers
    // rather than the legacy module's imperative listeners.
    expect(js).toContain("draggable");
    expect(js).toContain("onDragStart");
    expect(js).toContain("onDragOver");
    expect(js).toContain("onDragLeave");
    expect(js).toContain("onDrop");
    expect(js).toContain("onDragEnd");
    expect(js).toContain("getData");
    expect(js).toContain("setData");
    expect(js).toContain("text/plain");
    expect(js).toContain("effectAllowed");
    expect(js).toContain("dropEffect");
    // The drop-target highlight class the column renders.
    expect(js).toContain("drop-target");

    // The columns are labelled regions, and the board announces its own state.
    expect(js).toContain("aria-labelledby");
    expect(js).toContain("aria-live");
    expect(js).toContain("board-status");
    expect(js).toContain("role");
  });

  test("the board view is registered as a Preact component, not a legacy mount", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;

    // `features/board/index.ts` registers `{ kind: "component", component }`.
    // The string survives minification; the object shape is unit-tested at the
    // source level, so this asserts the component path is the one bundled.
    expect(js).toContain("component");
    expect(js).toContain("Board");
    // The shell's navigation entry for the board is still present.
    expect(js).toContain("#/board");
  });

  test("the legacy board module is not bundled", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;

    // Source-level names and calls from `src/web/board.js`. These are exactly
    // the identifiers a minifier leaves alone, so their presence would mean the
    // legacy module is still in the graph — and with it a second `board` view
    // registration and a second set of global drag listeners.
    for (const signature of LEGACY_BOARD_SIGNATURES) {
      expect(contains(js, signature), `legacy board signature present: ${signature}`).toBe(false);
    }

    // The legacy module's imperative drag wiring added listeners directly to
    // each column and toggled the class by hand. The component path expresses
    // the same behavior through Preact props, so no `dragover` listener is
    // registered imperatively at all.
    expect(js).not.toContain('addEventListener("dragover"');
    expect(js).not.toContain('addEventListener("drop"');
    expect(js).not.toContain('removeEventListener("dragover"');
    // Its `role="link"` card navigation is gone with it.
    expect(js).not.toContain('role: "link"');
    expect(js).not.toContain('role="link"');
  });

  test("no router, state library, or third-party asset is bundled", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;
    const css = STATIC_ASSETS["/assets/styles.css"]!.body;

    // State libraries and routers stay out: one hash-based shell owns routing
    // and board state lives in Preact hooks.
    for (const signature of DISALLOWED_LIBRARY_SIGNATURES) {
      expect(contains(js, signature), `disallowed library present: ${signature}`).toBe(false);
    }
    // React itself is not bundled. Preact's `preact/compat` alias is the way
    // that would happen by accident, and `react-dom` is the other.
    expect(js).not.toContain("react-dom");
    expect(js).not.toContain("ReactDOM");

    // No third-party host appears in either served asset.
    for (const host of THIRD_PARTY_HOSTS) {
      expect(contains(js, host), `third-party host in JavaScript: ${host}`).toBe(false);
      expect(contains(css, host), `third-party host in stylesheet: ${host}`).toBe(false);
    }

    // Every URL literal left in the bundle is an XML namespace identifier —
    // a string passed to `createElementNS`, not a fetch target. This is the
    // same distinction the entry document's favicon makes: the SVG namespace
    // URI is an identifier, not a request.
    const NAMESPACE_IDENTIFIERS = [
      "http://www.w3.org/2000/svg",
      "http://www.w3.org/1998/Math/MathML",
      "http://www.w3.org/1999/xhtml",
    ] as const;
    const urlLiterals = [...js.matchAll(/["']([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^"'\s]{0,120})["']/g)]
      .map((match) => match[1]!);
    for (const literal of urlLiterals) {
      expect(
        NAMESPACE_IDENTIFIERS as readonly string[],
        `unexpected remote URL literal in bundle: ${literal}`,
      ).toContain(literal);
      // Protocol-relative and plainly remote origins are never a namespace.
      expect(literal.startsWith("//"), literal).toBe(false);
    }
    // No protocol-relative reference anywhere, which is how a remote asset
    // would sneak past a same-origin looking path check.
    expect(js).not.toContain('"//');
    expect(js).not.toContain("'//");
    // The stylesheet fetches nothing at all: no @import, no remote font, and no
    // url() of any kind.
    expect(css).not.toContain("@import");
    expect(css).not.toContain("@font-face");
    expect(css).not.toContain("url(");
  });

  test("exactly one live SSE path is compiled in", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;

    // One event-feed owner: the shell subscribes once, and the board refreshes
    // from it through props rather than opening its own stream.
    expect(occurrences(js, "api/events")).toBe(1);
    // One transport implementation: the fetch-stream reader with the bearer
    // header. A browser-native EventSource cannot carry the header, and a
    // WebSocket transport was never part of the design.
    expect(js).not.toContain("EventSource");
    expect(js).not.toContain("WebSocket");
    expect(js).toContain("text/event-stream");
    expect(js).toContain("Authorization");
    // The lifecycle handle the shell closes on sign-out is still present.
    expect(js).toContain("abort");
  });

  test("the public asset contract is unchanged by the board migration", () => {
    // Phase C swapped the board renderer only. The asset table, the fixed path
    // set, and the content types must be byte-for-byte the same contract.
    expect(Object.keys(STATIC_ASSETS).sort()).toEqual([...EXPECTED_PATHS].sort());
    expect(STATIC_ASSETS["/assets/app.js"]?.contentType).toBe(JS_TYPE);
    expect(STATIC_ASSETS["/assets/styles.css"]?.contentType).toBe(CSS_TYPE);
    expect(STATIC_ASSETS["/"]?.contentType).toBe(HTML_TYPE);
    expect(STATIC_ASSETS["/"]!.body).toBe(STATIC_ASSETS["/index.html"]!.body);

    // The document still loads one script and one stylesheet, both same-origin.
    const html = STATIC_ASSETS["/"]!.body;
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]!);
    expect(scripts).toEqual(["/assets/app.js"]);
    const stylesheets = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)]
      .map((match) => match[1]!);
    expect(stylesheets).toEqual(["/assets/styles.css"]);
    expect(html.match(/<script\b/g)?.length).toBe(1);
    // No remote reference of any kind in the document.
    for (const value of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      const reference = value[1]!;
      if (reference === "" || reference.startsWith("data:")) continue;
      expect(reference, "remote reference").not.toMatch(/^(https?:)?\/\//);
      expect(reference, "non-absolute reference").toStartWith("/");
    }
  });

  test("branding survives the board migration", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;
    const html = STATIC_ASSETS["/"]!.body;

    // The Phase B branding contract is unchanged by Phase C.
    expect(js).toContain("Workboard");
    expect(js).toContain("Workboard home");
    expect(js).toContain("Primary navigation");
    expect(js).toContain("Sign out");
    expect(js).toContain("live-indicator");
    expect(html).toContain("<title>Workboard</title>");
    expect(html).toContain('id="app"');

    // And the Phase A placeholder shell is still absent.
    for (const marker of PHASE_A_MARKERS) {
      expect(js, marker).not.toContain(marker);
    }
  });

  test("the typed board renders against a live server at the fixed asset paths", async () => {
    // The markers above are asserted on the embedded table; this proves the
    // same bytes reach a browser over the real route, under the same content
    // type and cache policy, after the board migration.
    const server = startWithStatic();
    try {
      const bundle = await fetch(`${server.url}/assets/app.js`);
      expect(bundle.status).toBe(200);
      expect(bundle.headers.get("content-type")).toBe(JS_TYPE);
      expect(bundle.headers.get("cache-control")).toBe("no-cache");
      const served = await bundle.text();
      expect(served).toBe(STATIC_ASSETS["/assets/app.js"]!.body);
      // The typed board's structure is in what the browser actually receives.
      expect(served).toContain("board-column");
      expect(served).toContain("Move #");
      expect(served).toContain("Add item to");
      expect(served).not.toContain("cardNode");

      // The legacy board module URL stays a 404 rather than becoming a second,
      // independently loadable copy of the board.
      const legacy = await fetch(`${server.url}/assets/board.js`);
      expect(legacy.status).toBe(404);
      expect(legacy.headers.get("content-type") ?? "").not.toContain("javascript");

      // The stylesheet the typed board's class names resolve against is served
      // from the same fixed path.
      const styles = await fetch(`${server.url}/assets/styles.css`);
      expect(styles.status).toBe(200);
      expect(styles.headers.get("content-type")).toBe(CSS_TYPE);
      const servedCss = await styles.text();
      expect(servedCss).toContain("board-column");
      expect(servedCss).toContain("board-card");
      expect(servedCss).toContain("quick-add");
    } finally {
      server.stop();
    }
  });
});
