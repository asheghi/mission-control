// Task 18/19 end-to-end: exercises the compiled single binary from a clean
// directory — the runtime must not depend on source files or node_modules.
// Skips automatically when dist/workboard has not been built (bun run build).
//
// Phase B adds the Preact shell and semantic token layer to the same run: the
// executable serves the fixed asset paths, the bundle carries the shell
// (branding, primary navigation, sign-out, live status), the stylesheet carries
// the --wb-* tokens, and the binary still exposes the exact six-tool MCP
// contract.
//
// Phase E adds the typed detail view to that same run: the compiled bundle is
// the only place the *shipped* artifact is checked, so the detail markers below
// are asserted on the bytes the executable actually serves after `bun run
// build`.
//
// Phase F deletes the legacy frontend and asserts that deletion on the shipped
// bytes: the imperative board/list/detail modules, the `legacy-bridge.js` DOM and
// navigation bridge, and the `app.js` compatibility re-exports are gone, their
// former URLs are still 404s, and no compatibility symbol — the `mount` host,
// `setNavigateRenderer`, the DOM error bridge — survives inside the binary.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BINARY = join(import.meta.dir, "..", "..", "dist", "workboard");

// Markers of the Phase A placeholder shell that Phase B replaced. None may
// survive in the compiled bundle or the served document.
const PHASE_A_MARKERS = ["preact-marker", "phase-a", "Preact browser build active"] as const;

// --- Phase C: the typed board -------------------------------------------------
//
// The compiled binary embeds the browser bundle, so this is the only place the
// *shipped* artifact is checked for the board migration. The markers are the
// same class of literal the static suite uses — surviving minification because
// they are DOM strings or Preact slot-prop names, never minified identifiers.
// A Preact bundle contains no HTML source text, so element types are asserted
// as their string literals (`"select"`), not as tags (`<select`).

// The typed board's structure, card chrome, and per-column quick add.
const TYPED_BOARD_MARKERS = [
  "board-column",
  "board-column-title",
  "board-cards",
  "board-card-top",
  "board-card-bottom",
  "board-card-people",
  "quick-add",
] as const;

// Source-level signatures of the legacy `src/web/board.js` module. A minifier
// leaves these names and calls alone, so their presence would mean the legacy
// board is still bundled alongside the typed component.
const LEGACY_BOARD_SIGNATURES = [
  'addEventListener("dragover"',
  'addEventListener("drop"',
  'classList.add("drop-target")',
  'role: "link"',
  "cardNode",
  "quickAddForm",
  "renderCards",
  "changeStatus",
] as const;

// --- Phase D: the typed list --------------------------------------------------
//
// The compiled binary embeds the browser bundle, so this is the only place the
// *shipped* artifact is checked for the list migration. The markers are the same
// class of literal the static suite uses — surviving minification because they
// are DOM strings or Preact slot-prop names, never minified identifiers.

// The typed list's structure: table, filter toolbar, bulk-selection bar, footer.
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

// The visible strings a user reads, so they are contract rather than detail.
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

// Source-level signatures of the legacy `src/web/list.js` module. Their presence
// would mean the legacy list still ships alongside the typed component, with a
// second `list` view registration and synthetic `role="link"` rows.
const LEGACY_LIST_SIGNATURES = [
  "updateSelectionBar",
  "reapplyAssigneeFilter",
  "reapplyLabelFilter",
  "reapplySelectFilter",
  "syncClearButton",
  "renderRows",
  "resetFilters",
  "fetchPage",
  'role: "link"',
  "Open work item #",
  "Assign to…",
  "Select #",
] as const;

// --- Phase E: the typed detail ------------------------------------------------
//
// The compiled binary embeds the browser bundle, so this is the only place the
// *shipped* artifact is checked for the detail migration. The markers are the
// same class of literal the static suite uses — surviving minification because
// they are DOM strings, ARIA attributes, visible text, or Preact slot-prop
// names, never minified identifiers.

// The typed detail view's structure: header and title input, field controls,
// label editor, description tabs and panels, composer with its mention listbox,
// comment list, and history card with its diff rows.
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

// The accessible names the typed detail view carries. These are the
// user-visible strings, so they are contract rather than implementation.
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

// Source-level signatures of the legacy `src/web/detail.js` module. A minifier
// leaves these names and calls alone, so their presence would mean the legacy
// detail module still ships alongside the typed component, with a second
// `detail` registration and a second set of imperative handlers.
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
  "resolveAssignableParticipant",
  "tabIndexForKey",
] as const;

// --- Phase F: the legacy frontend is deleted ---------------------------------
//
// The compiled binary embeds the browser bundle, so this is the only place the
// *shipped* artifact is checked for the deletion itself. The source-tree suite
// proves the modules are off disk and out of the import graph; this proves the
// bytes the executable serves carry none of their signatures, that their former
// URLs are still 404s at the real route, and that the public asset contract —
// one bundle at one fixed path, one stylesheet, no external dependency — is
// exactly what it was before the deletion.

// Former module URLs for the deleted sources. None may become a ghost route, and
// `/assets/app.js` is deliberately absent: that is the one bundle path that *is*
// served, and it shares a basename with the deleted `src/web/app.js` module
// without sharing its URL.
const DELETED_LEGACY_PATHS = [
  "/assets/board.js",
  "/assets/list.js",
  "/assets/detail.js",
  "/assets/legacy-bridge.js",
  "/assets/views.js",
  "/assets/views.ts",
  "/assets/shell/LegacyView.js",
  "/assets/shell/LegacyView.tsx",
  "/app.js",
] as const;

// Source-level markers of the deleted modules and of the shell's compatibility
// surfaces. A minifier leaves these names and calls alone, so any one of them
// surviving in the shipped bytes means the legacy path is still compiled in.
const DELETED_LEGACY_BUNDLE_MARKERS = [
  // `legacy-bridge.js`
  "setNavigateRenderer",
  "navigateRenderer",
  // The inert `app.js` re-export surface
  "errorBanner",
  // The shell's DOM error bridge and legacy host
  "showMountError",
  "LegacyView",
  "LegacyHost",
  "LegacyLifecycle",
  "LegacyRoute",
  // The DOM error bridge built its own banner element; the top-level Preact
  // error boundary renders the shell's banner instead, so this exact call shape
  // is the deleted bridge's signature.
  'createElement("div")',
  // The registry's imperative registration shape
  "mount:",
] as const;

// The one JavaScript and one CSS bundle path, plus the document. Anything the
// page loads is one of these; anything else is a 404.
const FIXED_ASSET_PATHS = ["/", "/index.html", "/assets/app.js", "/assets/styles.css"] as const;

// Third-party origins that must never appear in a served asset, so the single
// executable stays genuinely offline.
const THIRD_PARTY_ASSET_HOSTS = [
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "esm.sh",
  "skypack.dev",
  "googleapis.com",
  "gstatic.com",
  "fonts.googleapis.com",
] as const;

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
    // Tracked outside the try so a failing assertion cannot leak a listening
    // server. Previously a throw before the graceful-shutdown step left the
    // spawned process running, and repeated failures piled up servers that
    // loaded the machine until this test timed out for unrelated reasons.
    let killServer: (() => Promise<void>) | null = null;
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
      killServer = async () => {
        server.kill("SIGKILL");
        await server.exited;
      };
      const reader = server.stderr.getReader();
      let stderrText = "";
      const deadline = Date.now() + 10_000;
      let baseUrl: string | null = null;
      while (Date.now() < deadline && baseUrl === null) {
        // The timeout sentinel must be distinguishable from a real stream end.
        // Resolving it as `{ done: true }` made the loop treat a slow first
        // chunk as end-of-stream and give up before the server had printed its
        // URL, so this test failed intermittently on a loaded machine.
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 250)),
        ]);
        if ("value" in chunk && chunk.value !== undefined) stderrText += new TextDecoder().decode(chunk.value);
        const match = stderrText.match(/listening on (http:\/\/\S+)/);
        if (match?.[1] !== undefined) baseUrl = match[1];
        else if ("done" in chunk && chunk.done) break;
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
      expect(shellHtml).toContain("<title>MissionControl</title>");
      const shellReferences = [...shellHtml.matchAll(/(?:href|src)="([^"]*)"/g)].map((match) => match[1]!);
      expect(shellReferences.filter((value) => !value.startsWith("data:")).sort()).toEqual([
        "/assets/app.js",
        "/assets/styles.css",
      ]);
      // One script, one stylesheet: the page has no second entry point it could
      // use to load a legacy module as its own page script.
      expect(shellHtml.match(/<script\b/g)?.length).toBe(1);
      expect(shellHtml.match(/<link\b[^>]*rel="stylesheet"/g)?.length).toBe(1);
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
        FIXED_ASSET_PATHS.map(async (path) => ({ path, response: await fetch(`${baseUrl}${path}`) })),
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
        "/assets/shell/AppShell.js",
        "/assets/features/list.js",
        "/assets/features/list/index.js",
        "/assets/features/list/ListView.js",
        "/assets/app.js.map",
        ...DELETED_LEGACY_PATHS,
      ]) {
        expect((await fetch(`${baseUrl}${path}`)).status, path).toBe(404);
      }
      // Phase F: the deleted modules are gone over HTTP, not merely unimported.
      // Each answers 404 with no JavaScript content type, so a stale document
      // could not load one even if it still referenced it.
      for (const path of DELETED_LEGACY_PATHS) {
        const response = await fetch(`${baseUrl}${path}`);
        expect(response.status, path).toBe(404);
        expect(response.headers.get("content-type") ?? "", path).not.toContain("javascript");
      }

      const bundle = await fetch(`${baseUrl}/assets/app.js`);
      expect(bundle.headers.get("content-type")).toContain("text/javascript");
      const bundleSource = await bundle.text();
      // Phase B: the Preact application shell is compiled in — branding, the
      // labeled primary navigation, sign-out, and the live status indicator.
      expect(bundleSource).toContain("MissionControl");
      expect(bundleSource).toContain("MissionControl home");
      expect(bundleSource).toContain("Primary navigation");
      expect(bundleSource).toContain("Sign out");
      expect(bundleSource).toContain("live-indicator");
      // It renders into the single #app host, and the live feed is the REST
      // event stream with the token kept in browser storage.
      expect(bundleSource).toContain("MissionControl application host is missing");
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

      // --- Phase C: the typed board is what shipped ------------------------
      //
      // The board is now a Preact component. These markers prove the compiled
      // binary serves the migrated board rather than a stale or empty bundle.
      for (const marker of TYPED_BOARD_MARKERS) {
        expect(bundleSource, `typed board marker missing: ${marker}`).toContain(marker);
      }
      // The four columns still render by their visible labels, and the empty
      // and failure states survive the migration.
      for (const label of ["To do", "Doing", "Blocked", "Done"]) {
        expect(bundleSource, `column label missing: ${label}`).toContain(label);
      }
      expect(bundleSource).toContain("No items");
      expect(bundleSource).toContain("Loading board");
      // The card title is a semantic native anchor, not a synthetic role link.
      expect(bundleSource).toContain("board-card-title");
      expect(bundleSource).toContain("#/item/");
      expect(bundleSource).toContain('"a"');
      // The status control is a native select with an accessible name, and the
      // title handles Left/Right so status changes work without dragging.
      expect(bundleSource).toContain("Move #");
      expect(bundleSource).toContain("to status");
      expect(bundleSource).toContain('"select"');
      expect(bundleSource).toContain("ArrowLeft");
      expect(bundleSource).toContain("ArrowRight");
      // Quick add is labelled per column and bounded.
      expect(bundleSource).toContain("Add item to");
      expect(bundleSource).toContain("maxLength");
      // Drag & drop survives as Preact slot props, reading the payload it wrote.
      expect(bundleSource).toContain("draggable");
      expect(bundleSource).toContain("onDragStart");
      expect(bundleSource).toContain("onDrop");
      expect(bundleSource).toContain("getData");
      expect(bundleSource).toContain("setData");
      expect(bundleSource).toContain("text/plain");

      // The legacy board module is not bundled: its imperative drag wiring and
      // its unminified helper names are all gone.
      for (const signature of LEGACY_BOARD_SIGNATURES) {
        expect(bundleSource, `legacy board signature present: ${signature}`).not.toContain(signature);
      }
      expect(bundleSource).not.toContain('addEventListener("dragover"');
      expect(bundleSource).not.toContain('role: "link"');
      expect(bundleSource).not.toContain('role="link"');

      // Exactly one event-feed owner: the SSE path appears once, and the
      // board refreshes from it rather than opening a second stream.
      expect(bundleSource.split("api/events").length - 1).toBe(1);

      // --- Phase D: the typed list is what shipped -------------------------
      //
      // The list is now a Preact component. These markers prove the compiled
      // binary serves the migrated list rather than a stale or empty bundle.
      for (const marker of TYPED_LIST_MARKERS) {
        expect(bundleSource, `typed list marker missing: ${marker}`).toContain(marker);
      }
      for (const marker of TYPED_LIST_LABEL_MARKERS) {
        expect(bundleSource, `typed list label missing: ${marker}`).toContain(marker);
      }
      // The empty, loading, and failure states survive the migration, so a user
      // never sees a blank table with no explanation.
      expect(bundleSource).toContain("Loading work items…");
      expect(bundleSource).toContain("Retry");
      for (const message of [
        "Could not load work items. Please try again.",
        "Some filter options could not be loaded.",
        "Workboard returned list data in an unexpected format.",
        "Could not load more work items because pagination did not advance.",
      ]) {
        expect(bundleSource, `list error message missing: ${message}`).toContain(message);
      }
      // The list is built from native controls and links each row with a real
      // anchor to the same `#/item/` route the board's card uses.
      expect(bundleSource).toContain('"select"');
      expect(bundleSource).toContain('"table"');
      expect(bundleSource).toContain("#/item/");
      expect(bundleSource).toContain("assigneeId");
      expect(bundleSource).toContain("Unassign");

      // Board, list, and detail are registered side by side with the same
      // component shape, and each route is registered exactly once.
      expect(bundleSource).toContain('{kind:"component",title:"All work",href:"#/list",component:');
      expect(bundleSource).toContain('{kind:"component",title:"Board",href:"#/board",component:');
      expect(bundleSource).toContain('{kind:"component",title:"Item",href:"#/item",hidden:!0,component:');
      expect(bundleSource.split('title:"All work",href:"#/list"').length - 1).toBe(1);
      // Phase E migrated the last legacy view, so no registration carries a
      // `mount` any more. That absence is what proves the checks below are
      // testing for the legacy modules' signatures rather than for `mount`.
      expect(bundleSource).not.toContain("mount:");

      // The legacy list module is not bundled: its imperative row and filter
      // helpers, its synthetic role-link rows, and its own visible strings are
      // all gone.
      for (const signature of LEGACY_LIST_SIGNATURES) {
        expect(bundleSource, `legacy list signature present: ${signature}`).not.toContain(signature);
      }

      // --- Phase E: the typed detail is what shipped -----------------------
      //
      // The detail view is now a Preact component too. These markers prove the
      // compiled binary serves the migrated item view rather than a stale or
      // empty bundle, and that it is built from accessible native controls.
      for (const marker of TYPED_DETAIL_MARKERS) {
        expect(bundleSource, `typed detail marker missing: ${marker}`).toContain(marker);
      }
      for (const marker of TYPED_DETAIL_LABEL_MARKERS) {
        expect(bundleSource, `typed detail label missing: ${marker}`).toContain(marker);
      }
      // The loading, refreshing, empty, and failure states survive, so a slow or
      // missing item is never a blank page, and every failure the hook can
      // publish is a literal in the shipped bytes.
      expect(bundleSource).toContain("Loading item…");
      expect(bundleSource).toContain("Refreshing item…");
      expect(bundleSource).toContain("Item not found");
      for (const message of [
        "Could not load this item. Please try again.",
        "Your change could not be saved. Please try again.",
        "The item could not be deleted. Please try again.",
        "Your latest edits could not be saved, so the item was not deleted.",
        "Label changes could not be saved. Please try again.",
        "Your comment could not be posted. Please try again.",
        "Title cannot be empty.",
        "Title must be 256 characters or fewer.",
        "Description must be 100,000 characters or fewer.",
        // Assembled at runtime from the shared label bound, so the minifier keeps
        // the two halves of the sentence as separate literals.
        "An item can have at most ",
      ]) {
        expect(bundleSource, `detail error message missing: ${message}`).toContain(message);
      }
      // The title input is reachable and named, and the page carries a real
      // heading rather than an unlabelled input.
      expect(bundleSource).toContain('for:"detail-title"');
      expect(bundleSource).toContain("detail-page-title");
      expect(bundleSource).toContain('"aria-label"');
      // The description is a real tablist with Preview/Edit tabs and panels.
      expect(bundleSource).toContain("tablist");
      expect(bundleSource).toContain("tabpanel");
      expect(bundleSource).toContain("aria-selected");
      // The comment composer is a real ARIA combobox over a listbox of mention
      // options, so @-mentions are usable from the keyboard.
      expect(bundleSource).toContain("combobox");
      expect(bundleSource).toContain("aria-autocomplete");
      expect(bundleSource).toContain("aria-activedescendant");
      expect(bundleSource).toContain("listbox");
      // The view is built from native controls and mirrors the server's bounds,
      // and the label input is offered the catalogue through a native datalist.
      expect(bundleSource).toContain('"textarea"');
      expect(bundleSource).toContain('"datalist"');
      expect(bundleSource).toContain("maxLength");
      expect(bundleSource).toContain("autoComplete");
      expect(bundleSource).toContain("256");
      expect(bundleSource).toContain("1e5");
      expect(bundleSource).toContain("64");
      expect(bundleSource).toContain("20");

      // The legacy detail module is not bundled: its inline-markdown scanner, its
      // LCS diff helpers, its imperative render functions, and the serial-queue
      // helper only it imported are all gone.
      for (const signature of LEGACY_DETAIL_SIGNATURES) {
        expect(bundleSource, `legacy detail signature present: ${signature}`).not.toContain(signature);
      }
      // No former detail module URL is served, and none became a ghost route.
      for (const path of [
        "/assets/detail.js",
        "/assets/features/detail.js",
        "/assets/features/detail/index.js",
        "/assets/features/detail/DetailView.js",
        "/assets/features/detail/data.js",
        "/assets/features/detail/components.js",
      ]) {
        expect((await fetch(`${baseUrl}${path}`)).status, path).toBe(404);
      }

      // --- Phase F: the legacy frontend is not in the shipped bytes ----------
      //
      // The deleted modules and the shell's compatibility surfaces are asserted
      // absent from what the executable actually serves. `mount:` is the registry
      // shape that would prove a registrant can still bypass the component host,
      // and the rest are the bridge's own names and calls.
      for (const marker of DELETED_LEGACY_BUNDLE_MARKERS) {
        expect(bundleSource, `deleted legacy marker present: ${marker}`).not.toContain(marker);
      }
      // Exactly one registration shape remains: `kind: "component"` with a
      // renderer, once per route and no more.
      expect(bundleSource.split('kind:"component"').length - 1).toBe(4);
      // One SSE path and one API client path, unchanged by the deletion.
      expect(bundleSource.split("api/events").length - 1).toBe(1);

      // No router or state library rode along, and React itself is absent.
      for (const signature of ["preact-router", "preact/compat", "TanStack", "QueryClient", "zustand", "redux"]) {
        expect(bundleSource, `disallowed library present: ${signature}`).not.toContain(signature);
      }
      expect(bundleSource).not.toContain("react-dom");
      // No third-party host, and no remote URL literal beyond the XML namespace
      // identifiers Preact passes to `createElementNS` — an identifier, not a
      // request target, exactly as the favicon's SVG namespace is.
      for (const host of ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "esm.sh", "googleapis.com"]) {
        expect(bundleSource, `third-party host present: ${host}`).not.toContain(host);
      }
      const namespaceIdentifiers = [
        "http://www.w3.org/2000/svg",
        "http://www.w3.org/1998/Math/MathML",
        "http://www.w3.org/1999/xhtml",
      ];
      for (const match of bundleSource.matchAll(/["']([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^"'\s]{0,120})["']/g)) {
        expect(namespaceIdentifiers, `unexpected remote URL literal: ${match[1]!}`).toContain(match[1]!);
      }

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
      // Phase F: the compatibility alias layer is gone, so every custom
      // property the stylesheet consumes is a --wb-* token defined in the token
      // layer. The legacy alias names appear neither as a declaration nor as a
      // `var()` reference.
      expect(stylesSource).toContain(".live-indicator");
      const consumedTokens = [...stylesSource.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]!);
      expect(consumedTokens.length).toBeGreaterThan(0);
      for (const token of consumedTokens) {
        expect(token, `non-semantic token consumed: ${token}`).toStartWith("--wb-");
      }
      // `--canvas-default:` also matches inside `--wb-color-canvas-default:`, so
      // the check is on the exact declaration and the exact `var()` reference.
      for (const alias of ["--canvas-default", "--fg-muted", "--focus-outline", "--radius", "--header-bg"]) {
        expect(stylesSource, `legacy alias referenced: ${alias}`).not.toContain(`var(${alias})`);
        expect(stylesSource, `legacy alias defined: ${alias}`).not.toMatch(new RegExp(`(^|[;{])${alias}:`));
      }
      expect(stylesSource).toMatch(/\.board-card\{[^}]*var\(--wb-shadow-small\)/);
      // Phase C: the typed board's class names resolve against this same
      // single stylesheet, and it still fetches nothing at all.
      expect(stylesSource).toContain("board-column");
      expect(stylesSource).toContain("board-card");
      expect(stylesSource).toContain("quick-add");
      // Phase D: the typed list's class names resolve against it too.
      expect(stylesSource).toContain("list-table");
      expect(stylesSource).toContain("list-toolbar");
      expect(stylesSource).toContain("selection-bar");
      expect(stylesSource).toContain("checkbox-hit-area");
      // Phase E: and the typed detail view's class names as well.
      expect(stylesSource).toContain("detail-title-input");
      expect(stylesSource).toContain("detail-history");
      expect(stylesSource).toContain("detail-comments");
      expect(stylesSource).toContain("mention-list");
      expect(stylesSource).toContain("diff-box");
      // The stylesheet still fetches nothing at all, after all three migrations.
      expect(stylesSource).not.toContain("@font-face");
      expect(stylesSource).not.toContain("url(");
      for (const host of THIRD_PARTY_ASSET_HOSTS) {
        expect(stylesSource, `third-party host in stylesheet: ${host}`).not.toContain(host);
      }

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
      killServer = null;
      writeFileSync(join(dir, "done"), "");
    } finally {
      // A server that never reached the graceful-shutdown step is still
      // listening; kill it so one failure cannot degrade later runs.
      if (killServer !== null) await killServer();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
