// Static web shell tests, updated for the Phase B Preact shell, the Phase D–E
// typed views, and the Phase F removal of the legacy frontend.
//
// The public surface is unchanged: `scripts/build-web.ts` bundles
// `src/web/main.tsx` (Preact plus the typed board, list, and detail features)
// into exactly two artifacts, and `src/web/static-assets.ts` is the single asset
// table the server embeds. This suite imports that same table rather than
// restating it, so a path that exists only in the source tree can never look
// "served" here.
//
// What changed for Phase B: the shell is now the top-level Preact application
// (branding, primary navigation, sign-out, live status), the Phase A marker is
// gone, and the stylesheet carries the `--wb-*` semantic token layer.
//
// What changed for Phase F: the legacy frontend is deleted rather than merely
// unreachable. The imperative `board.js`/`list.js`/`detail.js` modules, the
// inert `legacy-bridge.js` navigation/DOM bridge, and the `app.js` compatibility
// re-export surface are gone from the source tree, so no source module declares
// them as an embedded text asset any more. With them went the shell's last
// compatibility surfaces: the `mount` host, the legacy lifecycle/route types,
// the DOM error bridge, and the `setNavigateRenderer` shell hook.
//
// What is still asserted, in the same spirit as the original Task 12 suite:
// traversal-proof path matching, exact content types, the reserved-route
// dispatch order, and Workboard branding surviving inside the bundle.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
// The production view registry. Asserting on the registry the shell actually
// reads — rather than on a copy — is what makes "component-only" a contract.
import { views } from "../../../src/web/views";
// The registry is filled by the feature modules' import side effects, exactly as
// `src/web/main.tsx` fills it. Importing them here means these tests assert on
// the registry the shipped bundle actually builds, not an empty one.
import "../../../src/web/features/board";
import "../../../src/web/features/backlog";
import "../../../src/web/features/list";
import "../../../src/web/features/detail";

const HTML_TYPE = "text/html; charset=utf-8";
const JS_TYPE = "text/javascript; charset=utf-8";
const CSS_TYPE = "text/css; charset=utf-8";

const WEB_SOURCE_DIR = join(import.meta.dir, "..", "..", "..", "src", "web");

// The public surface stays fixed at exactly these four paths. Anything else
// under /assets/ — including the pre-bundle module URLs — must be a 404, so a
// stale index.html cannot quietly keep working against a missing file.
const EXPECTED_PATHS = ["/", "/index.html", "/assets/app.js", "/assets/styles.css"] as const;

// -----------------------------------------------------------------------------
// Phase F — the legacy frontend is deleted, not hidden
//
// Phase C/D/E replaced board, list, and detail one at a time while the legacy
// modules stayed in the tree. Phase F finishes the job: the imperative modules,
// the inert `legacy-bridge.js` DOM/navigation bridge they shared, and the
// `app.js` compatibility re-export surface are removed outright. Three failure
// modes are worth a test apiece, and none is visible to a unit test:
//
//   1. A module is still on disk (so it can be re-imported by a later change)
//      even though nothing serves it.
//   2. A deleted module is still reachable over HTTP, or is still a declared
//      text-asset import in `src/assets.d.ts`.
//   3. A compatibility symbol survives in the bundle — the `mount` host, the
//      `setNavigateRenderer` shell hook, the DOM error bridge — keeping the
//      legacy path alive with no module behind it.
// -----------------------------------------------------------------------------

// The legacy source modules Phase F deletes. Each is asserted absent from the
// source tree, from the served asset surface, and (by its signatures) from the
// bundle.
const DELETED_LEGACY_MODULES = [
  "board.js",
  "list.js",
  "detail.js",
  "legacy-bridge.js",
  "app.js",
  "shell/LegacyView.tsx",
] as const;

// Public URLs for the deleted modules. `app.js` is called out separately below
// because `/assets/app.js` is the one bundle path that *is* served — the
// deleted source module shares its basename but not its URL contract.
const DELETED_LEGACY_MODULE_PATHS = [
  "/assets/board.js",
  "/assets/list.js",
  "/assets/detail.js",
  "/assets/legacy-bridge.js",
  "/assets/views.js",
  "/assets/views.ts",
  "/assets/shell/LegacyView.js",
  "/assets/shell/LegacyView.tsx",
  "/assets/shell/ViewHost.js",
  "/assets/shell/AppShell.js",
  "/assets/legacy-bridge.js.map",
  "/app.js",
] as const;

// Source-tree module URLs that must never be served as their own asset: one
// bundle serves the whole UI, and no shell module must be reachable as an
// independently loadable page script. The deleted legacy modules are the same
// contract, asserted from the same list.
const LEGACY_MODULE_PATHS = [
  "/assets/api.js",
  "/assets/ui-state.js",
  "/assets/public-errors.js",
  "/assets/features/list.js",
  "/assets/features/list/index.js",
  "/assets/features/list/data.js",
  "/assets/features/list/ListView.js",
  "/assets/app.js.map",
  "/assets/ui-state.js.map",
  ...DELETED_LEGACY_MODULE_PATHS,
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

// -----------------------------------------------------------------------------
// Phase D — the typed list
//
// Phase D moves list rendering out of the legacy `src/web/list.js` module and
// into `src/web/features/list/*`, registered through the same view registry as a
// Preact component. As with the board, the bundle is minified, so nothing below
// may depend on a minified identifier, a formatting choice, or a helper's
// internal variable name. Every marker is a literal that survives minification —
// a class name, an ARIA attribute, a visible string, or a Preact slot-prop name.
// -----------------------------------------------------------------------------

// Product markers of the typed list: the table structure, the filter toolbar, the
// bulk-selection bar, and the pagination footer.
const TYPED_LIST_MARKERS = [
  "list-view",
  "list-toolbar",
  "list-table-scroller",
  "list-table",
  "list-labels",
  "list-item-title",
  "list-empty-row",
  "list-footer",
  "selection-bar",
  "checkbox-hit-area",
] as const;

// The accessible names and states the typed list carries. These are the
// user-visible strings, so they are contract rather than implementation. Both the
// hidden `<span>` and the `aria-label` fallback forms ship, because a Preact
// bundle contains no HTML source text.
const TYPED_LIST_LABEL_MARKERS = [
  "Filter work items",
  "All statuses",
  "Any assignee",
  "Any label",
  "Search titles",
  "Clear filters",
  "Load more",
  "Bulk actions",
  "Select all loaded work items",
  "Select work item #",
  "Work items table",
  "No work items match these filters.",
  "1 item loaded",
  " items loaded",
] as const;

// The three list failure states, which the hook renders as its own literal text.
// They survive minification and are the strings a user actually sees.
const TYPED_LIST_ERROR_MARKERS = [
  "Could not load work items. Please try again.",
  "Some filter options could not be loaded.",
  "Workboard returned list data in an unexpected format.",
  "Could not load more work items because pagination did not advance.",
] as const;

// The list refreshes from the shell's single event feed through props. These are
// the native controls the toolbar and selection bar are built from — asserted as
// element-type strings, since a Preact bundle holds no `<select` tag text.
const TYPED_LIST_CONTROL_MARKERS = [
  '"select"',
  '"option"',
  '"input"',
  '"table"',
  '"caption"',
  '"tr"',
  '"td"',
  "onChange",
  "onInput",
  "maxLength",
  "autoComplete",
] as const;

// Signatures of the legacy `src/web/list.js` module that the typed component
// replaced. These are source-level names and calls, so a minifier leaves them
// alone — which is exactly why their presence would mean the legacy module is
// still in the graph, re-registering the `list` view as a legacy `mount` and
// wiring a second set of imperative row handlers.
const LEGACY_LIST_SIGNATURES = [
  "updateSelectionBar",
  "reapplyAssigneeFilter",
  "reapplyLabelFilter",
  "reapplySelectFilter",
  "syncClearButton",
  "renderRows",
  "resetFilters",
  "fetchPage",
  // Its per-row rendering built a synthetic `role="link"` row that navigated on
  // click/keydown instead of a real anchor.
  'role: "link"',
  "Open work item #",
  // Its visible strings, distinct from the typed list's.
  "Assign to…",
  "Select #",
] as const;

// -----------------------------------------------------------------------------
// Phase E — the typed detail
//
// Phase E moves detail rendering out of the legacy `src/web/detail.js` module
// and into `src/web/features/detail/*`, registered through the same view
// registry as a Preact component. As with the board and the list, the bundle is
// minified, so nothing below may depend on a minified identifier, a formatting
// choice, or a helper's internal variable name. Every marker is either a literal
// that survives minification — a class name, an ARIA attribute, a visible string
// — or a DOM API the detail view must call.
// -----------------------------------------------------------------------------

// Product markers of the typed detail view: the header and its editable title,
// the field controls, the label editor, the description tabs, the comment
// composer with its mention listbox, the comment list, and the history card.
const TYPED_DETAIL_MARKERS = [
  "detail-title-input",
  "detail-controls",
  "detail-labels",
  "detail-body",
  "detail-comments",
  "detail-history",
  "comment-head",
  "mention-list",
  "mention-option",
  "diff-stat",
  "label-suggestion",
] as const;

// The accessible names and roles the typed detail view carries. These are the
// user-visible strings, so they are contract rather than implementation: both
// the tab labels and the failure copy ship as literals because a Preact bundle
// contains no HTML source text.
const TYPED_DETAIL_LABEL_MARKERS = [
  "Work item #",
  "Back to board",
  "Description view",
  "Preview",
  "Edit",
  "Mention suggestions",
  "Add a comment",
  "No comments yet.",
  "No history yet.",
  "No labels",
  "Add label…",
  "Delete item",
  "description changed",
] as const;

// The failure states the typed detail hook publishes. They survive minification
// and are the strings a user actually sees, so a silent blank page is a
// regression this catches.
const TYPED_DETAIL_ERROR_MARKERS = [
  "Could not load this item. Please try again.",
  "Your change could not be saved. Please try again.",
  "The item could not be deleted. Please try again.",
  "Your latest edits could not be saved, so the item was not deleted.",
  "Label changes could not be saved. Please try again.",
  "Your comment could not be posted. Please try again.",
  "Title cannot be empty.",
  "Title must be 256 characters or fewer.",
  "Description must be 100,000 characters or fewer.",
  // The label bound is assembled at runtime from the shared constant, so the
  // minifier keeps the two halves of the sentence as separate literals.
  "An item can have at most ",
] as const;

// The typed detail view is built from native controls and real Preact slots.
// These are asserted as element-type strings, since a Preact bundle holds no
// `<input` tag text.
const TYPED_DETAIL_CONTROL_MARKERS = [
  '"input"',
  '"textarea"',
  '"select"',
  '"datalist"',
  '"option"',
  "onInput",
  "onChange",
  "onKeyDown",
  "maxLength",
  "autoComplete",
] as const;

// Signatures of the legacy `src/web/detail.js` module that the typed component
// replaced. These are source-level names and calls, so a minifier leaves them
// alone — which is exactly why their presence would mean the legacy module is
// still in the graph, re-registering the `detail` view as a legacy `mount` and
// building a second copy of the same controls with imperative listeners.
const LEGACY_DETAIL_SIGNATURES = [
  "safeUrl",
  "renderInline",
  "renderMarkdown",
  "formatTime",
  "lcsOps",
  "diffCounts",
  "applyAssigneeSelection",
  "renderAssigneeOptions",
  "renderLabels",
  "scheduleTitleSave",
  "renderComments",
  "renderHistory",
  "renderHistoryEntry",
  // Its serial-queue helper and inline markdown scanner, which only it imported.
  "resolveAssignableParticipant",
  "tabIndexForKey",
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

interface WebSource {
  /** Path relative to `src/web`, so failures name the module, not an absolute path. */
  path: string;
  text: string;
}

/**
 * Every surviving module under `src/web`, as source text.
 *
 * Phase F asserts on the import graph rather than only on served bytes: a deleted
 * module that is still imported by a live one is a build failure in disguise, and
 * a second API client or SSE owner would only show up here. The walk is over
 * TypeScript sources only — the browser bundle is compiled from them, so they are
 * the whole graph.
 */
function sourceModuleText(): WebSource[] {
  const sources: WebSource[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") || entry.name.endsWith(".js")) {
        sources.push({ path: relative, text: readFileSync(absolute, "utf8") });
      }
    }
  };
  walk(WEB_SOURCE_DIR, "");
  return sources;
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
    expect(html).toContain("<title>MissionControl</title>");

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
      expect(servedAppJs).toContain("MissionControl");
      expect(servedAppJs).toContain("MissionControl home");
      expect(servedAppJs).toContain("Primary navigation");
      expect(servedAppJs).toContain("Sign out");
      expect(servedAppJs).toContain("live-indicator");
      // The shell is a Preact render into the single host element.
      expect(servedAppJs).toContain("getElementById");
      expect(servedAppJs).toContain("MissionControl application host is missing");
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
      // bootstrap are all absent from the bundle — and as of Phase F the source
      // module behind them no longer exists either.
      expect(servedAppJs).not.toContain("app.replaceChildren");
      expect(servedAppJs).not.toContain("function renderShell");
      expect(servedAppJs).not.toContain("renderLogin");
      expect(servedAppJs).not.toContain('addEventListener("hashchange",render');

      // Phase F: the compatibility bridge is gone with the modules that used it.
      // A surviving `setNavigateRenderer` would mean the shell still exports a
      // hook for an imperative view to re-render through; a surviving `mount:`
      // would mean the registry still accepts one.
      expect(servedAppJs).not.toContain("setNavigateRenderer");
      expect(servedAppJs).not.toContain("navigateRenderer");
      expect(servedAppJs).not.toContain("mount:");

      // Exactly one live transport, and it is the fetch-based SSE client:
      // a browser-native EventSource cannot carry the bearer header, and a
      // WebSocket transport was never part of this design.
      expect(servedAppJs).not.toContain("EventSource");
      expect(servedAppJs).not.toContain("WebSocket");
      // One SSE owner: the feed is opened once, by the shell.
      expect(occurrences(servedAppJs, "api/events")).toBe(1);

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

  test("the deleted legacy modules are absent from the source tree and the import graph", () => {
    // Failure mode 1: a module survives on disk and can be re-imported later.
    for (const relative of DELETED_LEGACY_MODULES) {
      expect(existsSync(join(WEB_SOURCE_DIR, relative)), `legacy module still on disk: ${relative}`).toBe(false);
    }

    // Failure mode 2: a deleted module is still declared as an embeddable text
    // asset. `src/assets.d.ts` is the only place a source module could be
    // re-admitted as a bundled string, so it must name none of them — and must
    // declare nothing beyond the two asset kinds the tree genuinely imports.
    const declarations = readFileSync(join(WEB_SOURCE_DIR, "..", "assets.d.ts"), "utf8");
    const declared = [...declarations.matchAll(/declare module "([^"]+)"/g)].map((match) => match[1]!);
    expect(declared.sort()).toEqual(["*.css", "*.html"]);
    for (const relative of DELETED_LEGACY_MODULES) {
      const basename = relative.split("/").pop()!;
      expect(declarations, `legacy module declared as an asset: ${basename}`).not.toContain(basename);
    }
    // `api.js`, `ui-state.js`, and `public-errors.js` are current shared modules,
    // not legacy ones — but they are ES imports, never text assets, so they must
    // not be declared here either.
    for (const shared of ["api.js", "ui-state.js", "public-errors.js", "views.js"]) {
      expect(declarations, `shared module declared as a text asset: ${shared}`).not.toContain(shared);
    }

    // Every surviving web source module is reachable from the single entrypoint,
    // and no surviving import names a deleted module.
    const sources = sourceModuleText();
    expect(sources.length).toBeGreaterThan(10);
    for (const legacy of ["./legacy-bridge", "../legacy-bridge", "./board", "./list", "./detail", "./app.js", "views.js"]) {
      for (const source of sources) {
        expect(source.text, `${source.path} still imports ${legacy}`).not.toContain(`"${legacy}"`);
      }
    }
    // The registry module is TypeScript now, and nothing imports the old path.
    expect(existsSync(join(WEB_SOURCE_DIR, "views.ts"))).toBe(true);
    expect(existsSync(join(WEB_SOURCE_DIR, "views.js"))).toBe(false);
  });

  test("the shell has no legacy host, lifecycle, route, or navigation bridge", () => {
    const shell = ["shell/AppShell.tsx", "shell/ViewHost.tsx", "shell/types.ts", "shell/safe-error.ts"]
      .map((relative) => ({ path: relative, text: readFileSync(join(WEB_SOURCE_DIR, relative), "utf8") }));
    const all = shell.map((file) => file.text).join("\n");

    // The compatibility type surface and the DOM mount/error bridge are gone.
    for (const symbol of [
      "LegacyView",
      "LegacyLifecycle",
      "LegacyRoute",
      "LegacyViewDefinition",
      "LegacyHost",
      "LegacyLifecycleHandle",
      "setNavigateRenderer",
      "showMountError",
      "errorBanner",
      "replaceChildren",
      "createElement",
    ]) {
      expect(all, `legacy shell symbol survives: ${symbol}`).not.toContain(symbol);
    }
    // The host is component-only: exactly one render path, no `kind` branch.
    const host = shell.find((file) => file.path === "shell/ViewHost.tsx")!;
    expect(host.text).toContain("export function ViewHost");
    expect(host.text).not.toContain('"legacy"');
    expect(host.text).not.toContain("view.kind ===");
    expect(existsSync(join(WEB_SOURCE_DIR, "shell", "LegacyView.tsx"))).toBe(false);
    // And the registry is a null-prototype record of component definitions: a
    // router lookup can never resolve an inherited Object.prototype key.
    expect(readFileSync(join(WEB_SOURCE_DIR, "views.ts"), "utf8")).toContain(
      "Object.assign(Object.create(null), {})",
    );
  });

  test("the registry holds component definitions only", () => {
    // The production registry, as the shell reads it. Every entry is a component
    // definition with a real renderer — there is no `mount` registrant left and
    // no `kind` other than "component".
    const entries = Object.entries(views);
    expect(entries.map(([name]) => name).sort()).toEqual(["backlog", "board", "detail", "list"]);
    for (const [name, entry] of entries) {
      expect(entry.kind, name).toBe("component");
      expect(typeof entry.component, name).toBe("function");
      expect((entry as { mount?: unknown }).mount, name).toBeUndefined();
      expect(entry.href, name).toStartWith("#/");
      expect(entry.title, name).not.toBe("");
    }
    // The registry has no prototype, so an inherited key is never a view.
    expect(Object.getPrototypeOf(views)).toBeNull();
    for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(views[inherited], inherited).toBeUndefined();
    }
  });

  test("exactly one API import path and one SSE owner remain", () => {
    const sources = sourceModuleText();

    // One API client module, imported through one relative path shape. Nothing
    // moved and no second client was added, so the suffix below is the contract.
    const apiImporters = sources.filter((source) => /from "[^"]*\/api\.js"/.test(source.text));
    expect(apiImporters.map((source) => source.path).sort()).toEqual([
      "features/backlog/BacklogView.tsx",
      "features/board/hooks.ts",
      "features/detail/hooks.ts",
      "features/list/hooks.ts",
      "public-errors.js",
      "shell/AppShell.tsx",
    ]);
    for (const source of apiImporters) {
      // `public-errors.js` sits beside the client and reaches it the same way,
      // so the shape is "ai.js or a relative climb up to it" — never a bare
      // specifier, a package name, or a second client under another path.
      const specifiers = [...source.text.matchAll(/from "([^"]*\/api\.js)"/g)].map((match) => match[1]!);
      expect(specifiers.length, source.path).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier, source.path).toMatch(/^(\.\/|(\.\.\/)+)api\.js$/);
      }
    }
    // The current shared modules are expected paths, not deletions.
    for (const shared of ["api.js", "ui-state.js", "public-errors.js"]) {
      expect(existsSync(join(WEB_SOURCE_DIR, shared)), `shared module missing: ${shared}`).toBe(true);
    }

    // One SSE owner: `api.js` owns the transport, the shell owns the single
    // subscription, and no view opens its own stream.
    const sseCallers = sources.filter((source) => source.text.includes("subscribeEvents("));
    expect(sseCallers.map((source) => source.path).sort()).toEqual(["api.js", "shell/AppShell.tsx"]);
    expect(occurrences(STATIC_ASSETS["/assets/app.js"]!.body, "api/events")).toBe(1);
  });


  test("the stylesheet consumes only semantic --wb-* tokens", () => {
    const css = STATIC_ASSETS["/assets/styles.css"]!.body;

    // Phase F deleted the compatibility alias layer. Every custom property the
    // stylesheet *consumes* is now a --wb-* token, so a rule can no longer paint
    // through an alias that a future token rename would silently orphan. Only
    // the definition sites are exempt, and those are the token layer itself.
    const consumed = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]!);
    expect(consumed.length).toBeGreaterThan(0);
    for (const token of consumed) {
      expect(token, `non-semantic token consumed: ${token}`).toStartWith("--wb-");
    }
    // The alias names are gone entirely — not merely unused.
    for (const alias of [
      "--canvas-default",
      "--canvas-subtle",
      "--canvas-inset",
      "--fg-default",
      "--fg-muted",
      "--border-default",
      "--border-muted",
      "--accent-fg",
      "--accent-emphasis",
      "--accent-muted",
      "--accent-subtle",
      "--success-fg",
      "--success-subtle",
      "--danger-fg",
      "--danger-subtle",
      "--attention-fg",
      "--attention-subtle",
      "--neutral-emphasis",
      "--shadow-small",
      "--shadow-medium",
      "--focus-outline",
      "--header-bg",
      "--base-white",
    ]) {
      // `var(--canvas-default)` and the definition `--canvas-default:` are both
      // failures: the first means a rule still consumes the alias, the second
      // that the alias block survived. A --wb-* token that merely *ends* in one
      // of these names (e.g. --wb-color-canvas-default) must not trip this.
      expect(css, `legacy alias consumed: ${alias}`).not.toContain(`var(${alias})`);
      expect(css, `legacy alias defined: ${alias}`).not.toContain(`${alias}:`);
    }

    // The tokens the components actually depend on are still defined, and the
    // radius/shadow aliases resolve to the token layer rather than vanishing
    // with the compatibility block that used to hold them.
    for (const token of [
      "--wb-color-canvas-default:",
      "--wb-color-focus-outline:",
      "--wb-radius-medium:",
      "--wb-shadow-small:",
      "--wb-shadow-medium:",
      "--wb-control-medium:",
    ]) {
      expect(css, `${token} is not defined`).toContain(token);
    }
    // A rule really does paint through the token core directly, which is the
    // whole point of the migration: the board card is the canonical example.
    expect(css).toMatch(/\.board-card\{[^}]*var\(--wb-shadow-small\)/);
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
      expect(source).toContain("MissionControl application host is missing");
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
    expect(js).toContain("MissionControl");
    expect(js).toContain("MissionControl home");
    expect(js).toContain("Primary navigation");
    expect(js).toContain("Sign out");
    expect(js).toContain("live-indicator");
    expect(html).toContain("<title>MissionControl</title>");
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

// -----------------------------------------------------------------------------
// Phase D — the typed list
//
// Phase D is a replacement, not an addition: `src/web/features/list/*` renders
// the list as a Preact component registered as `kind: "component"`, and the
// legacy `src/web/list.js` module is no longer part of the UI. The two failure
// modes are the same ones Phase C guarded for the board, and neither is visible
// to a unit test:
//
//   1. The replacement silently does not ship — the bundle is built from a
//      different entrypoint, or a stale asset table is embedded — so the list
//      renders nothing and no build error is raised.
//   2. The legacy module ships *alongside* the new component, re-registering the
//      `list` view with a `mount` and restoring the synthetic `role="link"` rows
//      and imperative filter handlers Phase D replaced.
//
// The Board and Detail contracts must survive the migration unchanged, so those
// are re-asserted here rather than assumed from the Phase C block.
// -----------------------------------------------------------------------------
describe("typed list bundle (Phase D)", () => {
  test("the served bundle carries the typed list's markers", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;

    // The table, filter toolbar, selection bar, and footer the components render.
    for (const marker of TYPED_LIST_MARKERS) {
      expect(contains(js, marker), `typed list marker missing: ${marker}`).toBe(true);
    }
    // The empty and loading states survive the migration.
    expect(js).toContain("No work items match these filters.");
    expect(js).toContain("Loading work items…");
    expect(js).toContain("Refreshing work items…");
  });

  test("the typed list's accessible names and states ship", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;

    for (const marker of TYPED_LIST_LABEL_MARKERS) {
      expect(contains(js, marker), `accessible-name marker missing: ${marker}`).toBe(true);
    }
    // The list announces its own state through a polite live region, and its
    // error alert offers a Retry.
    expect(js).toContain("aria-live");
    expect(js).toContain("aria-atomic");
    expect(js).toContain("Retry");
    // Every failure the hook can publish is a literal in the bundle, so the user
    // never sees a blank table with no explanation.
    for (const marker of TYPED_LIST_ERROR_MARKERS) {
      expect(contains(js, marker), `list error marker missing: ${marker}`).toBe(true);
    }
  });

  test("the list is built from native form controls and real anchors", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;
    const css = STATIC_ASSETS["/assets/styles.css"]!.body;

    for (const marker of TYPED_LIST_CONTROL_MARKERS) {
      expect(contains(js, marker), `list control marker missing: ${marker}`).toBe(true);
    }
    // Rows link to the detail view with a real anchor — the same `#/item/` route
    // the typed board's card uses — rather than the legacy synthetic role link.
    expect(js).toContain("#/item/");
    // Scrollable table region and its accessible name.
    expect(js).toContain("list-table-scroller");
    expect(js).toContain("Work items table");
    // Bulk assign delegates to the same update call the detail view uses.
    expect(js).toContain("assigneeId");
    expect(js).toContain("Unassign");

    // The list's class names resolve against the one served stylesheet.
    for (const selector of ["list-table", "list-toolbar", "selection-bar", "list-footer", "checkbox-hit-area"]) {
      expect(contains(css, selector), `list selector missing from stylesheet: ${selector}`).toBe(true);
    }
  });

  test("the list view is registered as a Preact component, not a legacy mount", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;

    // `features/list/index.ts` registers `{ kind: "component", component }`. The
    // strings survive minification; the object shape is unit-tested at the source
    // level, so this asserts the component path is the one bundled. Board and
    // list sit side by side with identical registration shapes.
    expect(js).toContain('{kind:"component",title:"All work",href:"#/list",component:');
    expect(js).toContain('{kind:"component",title:"Board",href:"#/board",component:');
    // The shell's navigation entry for the list is still present.
    expect(js).toContain("#/list");
    // Exactly one registration of the list route: a second one would mean two
    // `list` view definitions competing for the same hash route.
    expect(occurrences(js, 'title:"All work",href:"#/list"')).toBe(1);
  });

  test("the legacy list module is not bundled or served", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;

    // Source-level names and calls from `src/web/list.js`. A minifier leaves these
    // alone, so their presence would mean the legacy module is still in the graph
    // — and with it a second `list` view registration and a second set of
    // imperative row and filter handlers.
    for (const signature of LEGACY_LIST_SIGNATURES) {
      expect(contains(js, signature), `legacy list signature present: ${signature}`).toBe(false);
    }
    // Detail is no longer the one legacy view: Phase E migrated it to a Preact
    // component, so the legacy `mount` path has no remaining registrant. That
    // absence is exactly what the check above is testing for, now that the last
    // legacy view is gone.
    expect(js).not.toContain("mount:");

    // No former module URL serves a second, independently loadable copy of the
    // list — neither the legacy source module nor a pre-bundle feature module.
    for (const path of [
      "/assets/list.js",
      "/assets/features/list.js",
      "/assets/features/list/index.js",
      "/assets/features/list/ListView.js",
    ]) {
      expect(STATIC_ASSETS[path], `list module URL is served: ${path}`).toBeUndefined();
    }
  });

  test("the Board and Detail contracts survive the list migration", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;
    const css = STATIC_ASSETS["/assets/styles.css"]!.body;

    // The typed board is unchanged by Phase D.
    for (const marker of TYPED_BOARD_MARKERS) {
      expect(contains(js, marker), `typed board marker missing: ${marker}`).toBe(true);
    }
    expect(js).toContain("Move #");
    expect(js).toContain("Add item to");
    for (const signature of LEGACY_BOARD_SIGNATURES) {
      expect(contains(js, signature), `legacy board signature present: ${signature}`).toBe(false);
    }

    // Board, list, and detail are registered side by side with the same
    // component shape, and detail stays reachable from both migrated views
    // through the same `#/item/` route.
    expect(js).toContain('{kind:"component",title:"Item",href:"#/item",hidden:!0,component:');
    expect(js).toContain("#/item/");
    expect(js).toContain("hidden:!0");
    expect(css).toContain(".board-card");
    expect(css).toContain(".list-table");
  });

  test("no router, state library, or third-party asset is bundled", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;
    const css = STATIC_ASSETS["/assets/styles.css"]!.body;

    // The Phase C exclusions still hold after Phase D: one hash-based shell owns
    // routing and list state lives in Preact hooks rather than a store.
    for (const signature of DISALLOWED_LIBRARY_SIGNATURES) {
      expect(contains(js, signature), `disallowed library present: ${signature}`).toBe(false);
    }
    expect(js).not.toContain("react-dom");
    expect(js).not.toContain("ReactDOM");
    for (const host of THIRD_PARTY_HOSTS) {
      expect(contains(js, host), `third-party host in JavaScript: ${host}`).toBe(false);
      expect(contains(css, host), `third-party host in stylesheet: ${host}`).toBe(false);
    }
    // Still exactly one event-feed owner and one transport after the migration.
    expect(occurrences(js, "api/events")).toBe(1);
    expect(js).not.toContain("EventSource");
    expect(js).not.toContain("WebSocket");
  });

  test("the public asset contract is unchanged by the list migration", () => {
    // Phase D swapped the list renderer only. The asset table, the fixed path set,
    // and the content types must be the same two-artifact contract.
    expect(Object.keys(STATIC_ASSETS).sort()).toEqual([...EXPECTED_PATHS].sort());
    expect(STATIC_ASSETS["/assets/app.js"]?.contentType).toBe(JS_TYPE);
    expect(STATIC_ASSETS["/assets/styles.css"]?.contentType).toBe(CSS_TYPE);
    expect(STATIC_ASSETS["/"]?.contentType).toBe(HTML_TYPE);
    expect(STATIC_ASSETS["/"]!.body).toBe(STATIC_ASSETS["/index.html"]!.body);

    // The document still loads exactly one script and one stylesheet, and the
    // bundle pair is still the only pair the page fetches.
    const html = STATIC_ASSETS["/"]!.body;
    const networkPaths = referencedPaths(html).filter((value) => !value.startsWith("data:"));
    expect(networkPaths.sort()).toEqual(["/assets/app.js", "/assets/styles.css"]);
    expect(html.match(/<script\b/g)?.length).toBe(1);
    expect(html.match(/<link\b[^>]*rel="stylesheet"/g)?.length).toBe(1);
  });

  test("branding survives the list migration", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;
    const html = STATIC_ASSETS["/"]!.body;

    // The Phase B branding contract is unchanged by Phase D.
    expect(js).toContain("MissionControl");
    expect(js).toContain("MissionControl home");
    expect(js).toContain("Primary navigation");
    expect(js).toContain("Sign out");
    expect(js).toContain("live-indicator");
    expect(html).toContain("<title>MissionControl</title>");
    expect(html).toContain('id="app"');

    // And the Phase A placeholder shell is still absent.
    for (const marker of PHASE_A_MARKERS) {
      expect(js, marker).not.toContain(marker);
    }
  });

  test("the typed list renders against a live server at the fixed asset paths", async () => {
    // The markers above are asserted on the embedded table; this proves the same
    // bytes reach a browser over the real route, under the same content type and
    // cache policy, after the list migration.
    const server = startWithStatic();
    try {
      const bundle = await fetch(`${server.url}/assets/app.js`);
      expect(bundle.status).toBe(200);
      expect(bundle.headers.get("content-type")).toBe(JS_TYPE);
      expect(bundle.headers.get("cache-control")).toBe("no-cache");
      const served = await bundle.text();
      expect(served).toBe(STATIC_ASSETS["/assets/app.js"]!.body);
      // The typed list's structure is in what the browser actually receives.
      expect(served).toContain("list-table");
      expect(served).toContain("Filter work items");
      expect(served).toContain("Select work item #");
      expect(served).not.toContain("updateSelectionBar");

      // Every former list module URL stays a 404 rather than becoming a second,
      // independently loadable copy of the list.
      for (const path of ["/assets/list.js", "/assets/features/list.js", "/assets/features/list/index.js"]) {
        const legacy = await fetch(`${server.url}${path}`);
        expect(legacy.status, path).toBe(404);
        expect(legacy.headers.get("content-type") ?? "", path).not.toContain("javascript");
      }

      // The stylesheet the typed list's class names resolve against is served from
      // the same fixed path.
      const styles = await fetch(`${server.url}/assets/styles.css`);
      expect(styles.status).toBe(200);
      expect(styles.headers.get("content-type")).toBe(CSS_TYPE);
      const servedCss = await styles.text();
      expect(servedCss).toContain("list-table");
      expect(servedCss).toContain("list-toolbar");
      expect(servedCss).toContain("selection-bar");
    } finally {
      server.stop();
    }
  });
});

// -----------------------------------------------------------------------------
// Phase E — the typed detail
//
// Phase E is a replacement, not an addition: `src/web/features/detail/*` renders
// the detail view as a Preact component registered as `kind: "component"`, and
// the legacy `src/web/detail.js` module is no longer part of the UI. With it, the
// last `mount` registrant is gone and the bundle has no legacy view left. The two
// failure modes are the same ones Phase C and Phase D guarded, and neither is
// visible to a unit test:
//
//   1. The replacement silently does not ship — the bundle is built from a
//      different entrypoint, or a stale asset table is embedded — so `#/item/:id`
//      renders nothing and no build error is raised.
//   2. The legacy module ships *alongside* the new component, re-registering the
//      `detail` view with a `mount` and restoring a second set of imperative
//      title, label, comment, and history handlers.
//
// The Board and List contracts must survive the migration unchanged, so those are
// re-asserted here rather than assumed from the Phase C and D blocks.
// -----------------------------------------------------------------------------
describe("typed detail bundle (Phase E)", () => {
  test("the served bundle carries the typed detail view's markers", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;

    // The header, controls, label editor, tabs, composer, comments, and history
    // the components render.
    for (const marker of TYPED_DETAIL_MARKERS) {
      expect(contains(js, marker), `typed detail marker missing: ${marker}`).toBe(true);
    }
    // The loading, refreshing, empty, and not-found states survive the migration,
    // so a slow or missing item is never a blank page.
    expect(js).toContain("Loading item…");
    expect(js).toContain("Refreshing item…");
    expect(js).toContain("Item not found");
    expect(js).toContain("Retry");
  });

  test("the typed detail view's accessible names and states ship", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;

    for (const marker of TYPED_DETAIL_LABEL_MARKERS) {
      expect(contains(js, marker), `accessible-name marker missing: ${marker}`).toBe(true);
    }
    // The view announces its own state through one polite live region and its
    // failures through an assertive alert, and the mention combobox exposes the
    // full ARIA combobox contract rather than a plain textarea.
    expect(js).toContain("aria-live");
    expect(js).toContain("aria-atomic");
    expect(js).toContain("combobox");
    expect(js).toContain("aria-autocomplete");
    expect(js).toContain("aria-activedescendant");
    expect(js).toContain("aria-expanded");
    // The description tabs are a real tablist whose panels are labelled by them.
    expect(js).toContain("tablist");
    expect(js).toContain("tabpanel");
    expect(js).toContain("aria-selected");
    // Every failure the hook can publish is a literal in the bundle, so the user
    // never sees a stale or empty view with no explanation.
    for (const marker of TYPED_DETAIL_ERROR_MARKERS) {
      expect(contains(js, marker), `detail error marker missing: ${marker}`).toBe(true);
    }
    // No raw server or JavaScript error text may reach the user: the messages
    // above, plus the generic API-error copy, are the whole set the view can
    // display. (`TypeError` itself does appear in the bundle as the type thrown
    // by a programming-error guard, which is not user-facing text.)
    expect(js).not.toContain("[object Object]");
    expect(js).not.toContain("Failed to fetch");
    expect(js).not.toContain("SyntaxError");
    expect(js).not.toContain("is not a function");
  });

  test("the detail view is built from native controls and server-mirrored limits", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;
    const css = STATIC_ASSETS["/assets/styles.css"]!.body;

    for (const marker of TYPED_DETAIL_CONTROL_MARKERS) {
      expect(contains(js, marker), `detail control marker missing: ${marker}`).toBe(true);
    }
    // The title and description inputs carry the server's own bounds, so a
    // too-long value is refused before it can become a 400.
    expect(js).toContain("256");
    expect(js).toContain("1e5");
    expect(js).toContain("64");
    expect(js).toContain("20");
    // The label input is offered the catalogue through a native datalist, and
    // the mention listbox is keyed by the participant id the server sent.
    expect(js).toContain("datalist");
    expect(js).toContain("listbox");
    expect(js).toContain("#/board");

    // The detail view's class names resolve against the one served stylesheet.
    for (const selector of [
      "detail-title-input",
      "detail-controls",
      "detail-labels",
      "detail-body",
      "detail-comments",
      "detail-history",
      "mention-list",
      "mention-option",
      "diff-box",
    ]) {
      expect(contains(css, selector), `detail selector missing from stylesheet: ${selector}`).toBe(true);
    }
  });

  test("the detail view is registered as a Preact component, not a legacy mount", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;

    // `features/detail/index.ts` registers `{ kind: "component", component }`.
    // The strings survive minification; the object shape is unit-tested at the
    // source level, so this asserts the component path is the one bundled. Board,
    // list, and detail now sit side by side with identical registration shapes.
    expect(js).toContain('{kind:"component",title:"Item",href:"#/item",hidden:!0,component:');
    expect(js).toContain('{kind:"component",title:"All work",href:"#/list",component:');
    expect(js).toContain('{kind:"component",title:"Board",href:"#/board",component:');
    // The hidden detail route stays reachable from both migrated views.
    expect(js).toContain("#/item/");
    // Exactly one registration of the detail route: a second one would mean two
    // `detail` view definitions competing for the same hash route. The route
    // prefix itself appears once per view that links to an item — both migrated
    // views do — plus the registration, so it is counted rather than assumed.
    expect(occurrences(js, 'title:"Item",href:"#/item"')).toBe(1);
    expect(occurrences(js, "#/item/")).toBeGreaterThanOrEqual(2);
  });

  test("the legacy detail module is not bundled, and no legacy mount remains", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;

    // Source-level names and calls from `src/web/detail.js`. A minifier leaves
    // these alone, so their presence would mean the legacy module is still in the
    // graph — and with it a second `detail` view registration and a second set of
    // imperative title, label, comment, and history handlers.
    for (const signature of LEGACY_DETAIL_SIGNATURES) {
      expect(contains(js, signature), `legacy detail signature present: ${signature}`).toBe(false);
    }
    // With detail migrated, no view definition carries a `mount` any more: the
    // registry's legacy path has no remaining registrant.
    expect(js).not.toContain("mount:");
    // The two class names the legacy module shared with the typed view are kept
    // on purpose — the stylesheet and both suites still target them — so their
    // presence is not a legacy-module signal.
    expect(js).toContain('class:"detail-title-input"');

    // No former module URL serves a second, independently loadable copy of the
    // detail view — neither the legacy source module nor a pre-bundle feature
    // module.
    for (const path of [
      "/assets/detail.js",
      "/assets/features/detail.js",
      "/assets/features/detail/index.js",
      "/assets/features/detail/DetailView.js",
      "/assets/features/detail/data.js",
      "/assets/features/detail/components.js",
    ]) {
      expect(STATIC_ASSETS[path], `detail module URL is served: ${path}`).toBeUndefined();
    }
  });

  test("the Bundle and List contracts survive the detail migration", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;
    const css = STATIC_ASSETS["/assets/styles.css"]!.body;

    // The typed board is unchanged by Phase E.
    for (const marker of TYPED_BOARD_MARKERS) {
      expect(contains(js, marker), `typed board marker missing: ${marker}`).toBe(true);
    }
    expect(js).toContain("Move #");
    expect(js).toContain("Add item to");
    for (const signature of LEGACY_BOARD_SIGNATURES) {
      expect(contains(js, signature), `legacy board signature present: ${signature}`).toBe(false);
    }

    // The typed list is unchanged by Phase E.
    for (const marker of TYPED_LIST_MARKERS) {
      expect(contains(js, marker), `typed list marker missing: ${marker}`).toBe(true);
    }
    for (const marker of TYPED_LIST_LABEL_MARKERS) {
      expect(contains(js, marker), `typed list label missing: ${marker}`).toBe(true);
    }
    for (const signature of LEGACY_LIST_SIGNATURES) {
      expect(contains(js, signature), `legacy list signature present: ${signature}`).toBe(false);
    }
    // The detail route the board's card and the list's row both link through is
    // still the same anchor target.
    expect(occurrences(js, "#/item/")).toBeGreaterThanOrEqual(2);
    expect(css).toContain(".board-card");
    expect(css).toContain(".list-table");
  });

  test("no router, state library, or third-party asset is bundled", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;
    const css = STATIC_ASSETS["/assets/styles.css"]!.body;

    // The Phase C/D exclusions still hold after Phase E: one hash-based shell owns
    // routing and every view's state lives in Preact hooks rather than a store.
    for (const signature of DISALLOWED_LIBRARY_SIGNATURES) {
      expect(contains(js, signature), `disallowed library present: ${signature}`).toBe(false);
    }
    expect(js).not.toContain("react-dom");
    expect(js).not.toContain("ReactDOM");
    for (const host of THIRD_PARTY_HOSTS) {
      expect(contains(js, host), `third-party host in JavaScript: ${host}`).toBe(false);
      expect(contains(css, host), `third-party host in stylesheet: ${host}`).toBe(false);
    }
    // Still exactly one event-feed owner and one transport after the migration.
    expect(occurrences(js, "api/events")).toBe(1);
    expect(js).not.toContain("EventSource");
    expect(js).not.toContain("WebSocket");
  });

  test("the public asset contract is unchanged by the detail migration", () => {
    // Phase E swapped the detail renderer only. The asset table, the fixed path
    // set, and the content types must be the same two-artifact contract: exactly
    // one JavaScript bundle and one stylesheet.
    expect(Object.keys(STATIC_ASSETS).sort()).toEqual([...EXPECTED_PATHS].sort());
    expect(STATIC_ASSETS["/assets/app.js"]?.contentType).toBe(JS_TYPE);
    expect(STATIC_ASSETS["/assets/styles.css"]?.contentType).toBe(CSS_TYPE);
    expect(STATIC_ASSETS["/"]?.contentType).toBe(HTML_TYPE);
    expect(STATIC_ASSETS["/"]!.body).toBe(STATIC_ASSETS["/index.html"]!.body);

    // The document still loads exactly one script and one stylesheet, and the
    // bundle pair is still the only pair the page fetches.
    const html = STATIC_ASSETS["/"]!.body;
    const networkPaths = referencedPaths(html).filter((value) => !value.startsWith("data:"));
    expect(networkPaths.sort()).toEqual(["/assets/app.js", "/assets/styles.css"]);
    expect(html.match(/<script\b/g)?.length).toBe(1);
    expect(html.match(/<link\b[^>]*rel="stylesheet"/g)?.length).toBe(1);
    // One concatenated stylesheet: the detail styles are compiled into it rather
    // than fetched as a second file.
    expect(STATIC_ASSETS["/assets/styles.css"]!.body).not.toContain("@import");
  });

  test("branding survives the detail migration", () => {
    const js = STATIC_ASSETS["/assets/app.js"]!.body;
    const html = STATIC_ASSETS["/"]!.body;

    // The Phase B branding contract is unchanged by Phase E.
    expect(js).toContain("MissionControl");
    expect(js).toContain("MissionControl home");
    expect(js).toContain("Primary navigation");
    expect(js).toContain("Sign out");
    expect(js).toContain("live-indicator");
    expect(html).toContain("<title>MissionControl</title>");
    expect(html).toContain('id="app"');

    // And the Phase A placeholder shell is still absent.
    for (const marker of PHASE_A_MARKERS) {
      expect(js, marker).not.toContain(marker);
    }
  });

  test("the typed detail view renders against a live server at the fixed asset paths", async () => {
    // The markers above are asserted on the embedded table; this proves the same
    // bytes reach a browser over the real route, under the same content type and
    // cache policy, after the detail migration.
    const server = startWithStatic();
    try {
      const bundle = await fetch(`${server.url}/assets/app.js`);
      expect(bundle.status).toBe(200);
      expect(bundle.headers.get("content-type")).toBe(JS_TYPE);
      expect(bundle.headers.get("cache-control")).toBe("no-cache");
      const served = await bundle.text();
      expect(served).toBe(STATIC_ASSETS["/assets/app.js"]!.body);
      // The typed detail view's structure is in what the browser actually
      // receives, and the legacy module's helpers are not.
      expect(served).toContain("detail-title-input");
      expect(served).toContain("Mention suggestions");
      expect(served).toContain("Could not load this item. Please try again.");
      expect(served).not.toContain("renderMarkdown");
      expect(served).not.toContain("diffCounts");

      // Every former detail module URL stays a 404 rather than becoming a second,
      // independently loadable copy of the item view.
      for (const path of ["/assets/detail.js", "/assets/features/detail/index.js", "/assets/features/detail/DetailView.js"]) {
        const legacy = await fetch(`${server.url}${path}`);
        expect(legacy.status, path).toBe(404);
        expect(legacy.headers.get("content-type") ?? "", path).not.toContain("javascript");
      }

      // The stylesheet the typed detail view's class names resolve against is
      // served from the same fixed path.
      const styles = await fetch(`${server.url}/assets/styles.css`);
      expect(styles.status).toBe(200);
      expect(styles.headers.get("content-type")).toBe(CSS_TYPE);
      const servedCss = await styles.text();
      expect(servedCss).toContain("detail-title-input");
      expect(servedCss).toContain("detail-history");
      expect(servedCss).toContain("mention-list");
    } finally {
      server.stop();
    }
  });
});
