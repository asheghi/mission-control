# Workboard Web UI Modernization Specification

## 0. Purpose and handoff

This document specifies the next-generation Workboard web UI so another implementation agent can execute it without revisiting the major architecture decisions.

The current web UI is a working set of dependency-free JavaScript modules and one CSS file under `src/web/`. The migration must preserve current behavior while replacing manual DOM rendering with a typed component architecture.

Before changing code, read:

1. `README.md`
2. `PLAN.md`
3. `docs/plans/main-product-implementation.md`
4. `docs/verification.md`
5. Every existing file under `src/web/`
6. `src/cli.ts` and the static-asset handling in `src/api/app.ts`

Implement this plan in phases. Keep each phase independently buildable and testable. Do not perform a flag-day rewrite.

## 1. Frozen decisions

These decisions are settled unless the owner explicitly changes them:

1. **UI framework:** Preact with TypeScript and TSX.
2. **Frontend bundler:** Bun's bundler through `Bun.build` or the equivalent Bun CLI. Do not introduce Vite, Webpack, Parcel, or another frontend build system.
3. **Runtime topology:** the existing Workboard Bun HTTP server serves both the web UI and API in development and production. Do not start a separate frontend development server or add proxy-only routes.
4. **Deployment:** production remains one offline, self-contained Bun executable containing the server, CLI, MCP adapters, migrations, and web assets. It must not require Node.js, `node_modules`, a CDN, or an external asset directory at runtime.
5. **Dependencies:** install frontend dependencies locally at pinned versions and bundle them. Do not load executable JavaScript, CSS, fonts, icons, or framework code from a CDN.
6. **Design system:** use GitHub Primer Product as the interaction and visual reference, but implement a small Workboard-owned, CSS-first design system. Do not adopt Primer React, shadcn/ui, or a large component suite by default.
7. **Styling:** semantic CSS custom properties are the theming contract. Components consume semantic tokens rather than hard-coded theme values.
8. **Routing:** keep one public route scheme in all modes. Development and production must expose the same UI, asset, API, SSE, and MCP paths.
9. **State libraries:** begin with Preact state/hooks and the existing API/SSE model. Do not add TanStack Query, Redux, Zustand, or a router until a concrete requirement justifies it.
10. **Code splitting:** begin with one browser JavaScript entry and one CSS output. Add splitting only when measurements demonstrate a benefit and the embedded-asset pipeline handles chunks correctly.
11. **Migration:** migrate the shell and shared primitives first, then board, list, and detail behavior incrementally. Existing behavior remains the contract during migration.

## 2. Goals and non-goals

### Goals

- Give the web UI a maintainable typed component structure.
- Establish reusable tokens and accessible interface primitives.
- Preserve Workboard's current board, list, detail, filtering, mutation, authentication, and SSE behavior.
- Keep development and production routing behavior aligned.
- Make frontend builds deterministic and compatible with `bun build --compile`.
- Preserve fast local startup and offline operation.
- Support responsive desktop and narrow-screen layouts, visible focus, keyboard operation, reduced motion, and light/dark host themes.

### Non-goals

- No full-stack frontend framework or SSR runtime.
- No separate Vite development server.
- No public CDN dependency.
- No redesign of REST, MCP, SQLite, authentication, or the event protocol unless a verified frontend blocker requires it.
- No broad component catalog built speculatively.
- No visual clone of GitHub; Primer is a reference, not a requirement to reproduce branding.
- No desktop shell such as Electron or Tauri.

## 3. Target architecture

```text
src/web/
├── index.html
├── main.tsx
├── app.tsx
├── api/
│   ├── client.ts
│   └── types.ts
├── events/
│   └── feed.ts
├── state/
│   └── ui-state.ts
├── design-system/
│   ├── tokens.css
│   ├── base.css
│   ├── components.css
│   ├── icons/
│   └── components/
│       ├── Button.tsx
│       ├── IconButton.tsx
│       ├── TextInput.tsx
│       ├── Select.tsx
│       ├── Dialog.tsx
│       ├── ActionMenu.tsx
│       ├── LabelToken.tsx
│       ├── Flash.tsx
│       ├── Spinner.tsx
│       └── EmptyState.tsx
├── features/
│   ├── board/
│   ├── list/
│   └── detail/
└── styles/
    └── app.css

scripts/
├── build-web.ts
└── generate-embedded-assets.ts   # only if generation is required

dist/web/                         # generated; never required at production runtime
```

Adapt names to repository conventions when warranted, but retain separation between design-system primitives and product-specific feature components.

### Layer responsibilities

- **Design system:** generic presentation and interaction primitives; no Workboard API calls.
- **Feature components:** board/list/detail behavior and domain-specific composition.
- **API client:** HTTP transport, response parsing, safe errors, and authentication handling.
- **Event feed:** SSE lifecycle, bounded reconnect policy, and refresh notifications.
- **Application shell:** navigation, route interpretation, top-level state, and error boundaries.
- **Server asset provider:** maps request paths to generated assets; UI code does not know whether assets came from disk, memory, or the compiled executable.

## 4. Build and serving contract

The web build and executable build are two ordered targets:

```text
Preact/TypeScript source
  -> Bun browser-target build
  -> deterministic HTML/JS/CSS assets
  -> embedded asset table/module
  -> Bun server compile
  -> dist/workboard
```

Required scripts should be conceptually equivalent to:

```json
{
  "scripts": {
    "build:web": "bun run scripts/build-web.ts",
    "build": "bun run build:web && bun build ./src/entry.ts --compile --outfile dist/workboard"
  }
}
```

Exact script names may vary, but `bun run build` must always rebuild the browser assets before compiling the executable.

### Browser build requirements

- Target browsers, not Bun.
- Compile TSX and TypeScript.
- Bundle pinned Preact dependencies locally.
- Produce deterministic production output.
- Minify production output.
- Generate source maps only when they do not become runtime requirements or leak sensitive material.
- Start without code splitting.
- Fail the build on diagnostics or missing outputs.
- Do not mutate checked-in source files during an ordinary build. If a generated embedding module is needed, place it in a clearly generated location and make stale-output handling explicit.

### Asset embedding requirements

- Embed every required HTML, JavaScript, CSS, icon, font, and manifest asset in the compiled executable.
- Use explicit text/file loaders or a generated asset table so Bun does not execute browser JavaScript while compiling the server.
- Associate every path with the correct MIME type.
- Hashed assets, if introduced, use immutable caching; HTML must not be cached immutably.
- UI fallback must never shadow `/api`, `/mcp`, `/healthz`, or `/api/events`.
- A clean-directory production test must run using only `dist/workboard` and a new data directory.

### Development topology

Development uses the same Workboard server and public URLs as production:

```text
Browser -> Workboard server -> web assets
                         \-> REST API
                         \-> SSE
                         \-> MCP
```

Acceptable initial workflow:

1. Rebuild web assets with Bun.
2. Restart or watch the existing Workboard server.
3. Refresh the browser manually.

A later dev-only SSE reload endpoint is optional. It must not create a second server, alter production routing, or be included unless it materially improves the workflow.

## 5. Design system specification

### Reference and ownership

GitHub Primer Product is the reference for dense product UI patterns, hierarchy, spacing, controls, focus treatment, empty states, menus, dialogs, and accessible interaction. Workboard owns its implementation and public CSS/component API.

Do not copy GitHub branding or import Primer's implementation wholesale. Prefer a small coherent system tailored to Workboard.

### Token model

Define semantic custom properties using a Workboard prefix. At minimum cover:

- canvas/default/subtle/inset backgrounds
- foreground/default/muted/on-emphasis
- border/default/muted/emphasis
- accent, success, attention, danger, and done states
- focus outline
- spacing scale
- font family, size, weight, and line height
- border radius
- control heights
- elevation/shadow
- motion duration/easing
- layout widths and responsive breakpoints where useful

Example naming:

```css
:root {
  --wb-color-canvas-default: ...;
  --wb-color-fg-default: ...;
  --wb-color-border-default: ...;
  --wb-color-accent-emphasis: ...;
  --wb-space-2: 0.5rem;
  --wb-control-medium: 2rem;
  --wb-radius-medium: 0.375rem;
}
```

Rules:

- Feature CSS consumes semantic tokens.
- Avoid raw hex colors outside token definitions except documented one-off data colors.
- Theme integration overrides tokens rather than component selectors.
- Maintain readable contrast in supported themes.
- Respect `prefers-reduced-motion`.
- Do not communicate status or priority through color alone.

### Initial primitives

Implement only as demanded by migrated screens:

- Button and IconButton
- TextInput, Textarea, Select, and Checkbox
- SearchInput
- LabelToken/status token
- Flash/inline error
- Spinner/loading indicator
- EmptyState
- Dialog
- ActionMenu/Popover
- Tooltip only where visible labels are unsuitable

Dialog, menu, popover, and tooltip behavior must include correct focus management, dismissal, keyboard navigation, and ARIA semantics. If these prove disproportionately difficult, propose one small pinned headless accessibility dependency with evidence; do not silently add a full component suite.

### Product components

Keep these outside the generic design system:

- WorkItemCard
- StatusColumn
- Assignee/participant presentation
- FilterBar
- Activity/history entry
- Comment composer
- Item detail panel

## 6. Interaction and accessibility requirements

- All controls are reachable and usable by keyboard.
- Focus indicators are visible in every theme and are not removed without an equivalent.
- Every icon-only button has an accessible name and a discoverable tooltip where useful.
- Form controls have persistent labels or an equivalent accessible name; placeholders are not labels.
- Loading, success, and error feedback is visible and announced where appropriate.
- Dialog focus enters predictably, remains contained, closes with Escape where safe, and returns to the trigger.
- Drag-and-drop status changes have a non-drag keyboard/control alternative.
- Narrow layouts do not hide required actions or force page-level horizontal scrolling; board-column horizontal scrolling is acceptable when intentional.
- Touch targets are appropriately sized and controls do not depend on hover.
- Destructive actions require clear confirmation and must not be the default focused action.
- Authentication failures stop SSE retry loops and lead to a clear re-authentication state without exposing credentials.

## 7. Security and privacy requirements

- Keep tokens out of URLs, logs, rendered errors, screenshots, traces, and generated artifacts.
- Do not introduce `dangerouslySetInnerHTML` for untrusted content.
- Markdown must keep raw HTML disabled, allow only approved URL schemes, and apply safe external-link attributes.
- Render user/agent content as text unless it passes the owned Markdown pipeline.
- Avoid inline script requirements so a strict Content Security Policy remains feasible.
- Do not load runtime code or resources from third-party origins.
- Preserve authentication on every API and HTTP MCP route except `/healthz`; static shell availability must not expose board data.

## 8. Migration phases

### Phase A — Bun browser-build and embedding spike

1. Pin Preact and required type packages at exact compatible versions.
2. Create the smallest TSX entry that renders a static marker.
3. Bundle it with Bun for the browser.
4. Embed and serve the output through the existing server.
5. Compile the executable.
6. Run the executable in a clean temporary directory without `node_modules` or external assets.
7. Verify the same public paths in development and production.

Do not proceed until this proves the complete packaging path.

Acceptance:

- `bun run typecheck` succeeds.
- Browser build succeeds deterministically.
- `bun run build` produces one executable.
- The clean-directory executable renders the marker and serves API/health routes correctly.
- No frontend asset is fetched from a third-party origin.

### Phase B — Tokens, base styles, and application shell

1. Introduce semantic tokens and normalized base styles.
2. Implement the top-level Preact shell and navigation.
3. Preserve existing board/list/detail route behavior.
4. Add foundational controls only as required by the shell.
5. Establish a safe top-level error state.

Acceptance:

- Existing navigation URLs remain usable.
- Theme contrast and focus behavior pass visual review.
- Desktop and narrow viewports remain functional.
- Legacy feature modules can coexist temporarily without duplicated global listeners.

### Phase C — Board migration

1. Port board rendering to product components.
2. Preserve loading, empty, error, filtering, assignee, label, priority, and status presentation.
3. Preserve mutation scheduling semantics, including settled-burst behavior where currently required.
4. Preserve drag/drop if present and provide an accessible non-drag status control.
5. Refresh from SSE without duplicate listeners or conflicting optimistic updates.

Acceptance:

- Current board behavior remains intact after refresh.
- Mutations persist and failures visibly roll back/reconcile.
- Keyboard-only status changes work.
- No durable production board data is modified by verification.

### Phase D — List migration

1. Port list rendering, filters, and pagination.
2. Keep filters shareable in the URL if already supported.
3. Preserve stable results and clear empty/loading/error states.
4. Defer bulk operations unless they are already implemented and covered.

Acceptance:

- Filters compose correctly.
- Pagination does not duplicate or omit rows.
- Table/list remains usable on narrow screens.
- Keyboard focus order follows visual order.

### Phase E — Detail and composer migration

1. Port detail loading and editing.
2. Port comments and history.
3. Port participant, label, priority, and status controls.
4. Preserve mention completion and safe Markdown behavior.
5. Use the design-system dialog/panel and form primitives.

Acceptance:

- Editing one field does not clobber unrelated fields.
- Queued mutation behavior matches the established contract.
- Markdown XSS fixtures cannot execute code or unsafe links.
- Comment attribution comes only from the authenticated actor.
- Dialog/panel keyboard and focus behavior passes browser verification.

### Phase F — Remove legacy frontend path

1. Remove old manual-rendering modules only after all views have migrated.
2. Remove obsolete asset declarations and loaders.
3. Confirm there is one event-feed owner and one API client path.
4. Confirm no duplicate CSS rules or dead compatibility adapters remain.
5. Re-run the complete verification matrix and compiled-binary test.

Acceptance:

- No legacy web module is served or imported.
- Runtime does not need source files, `node_modules`, `dist/web`, or Internet access.
- The executable contains all required assets.
- Existing REST/MCP behavior remains unchanged.

## 9. Testing and completion gates

Each phase must add the narrowest useful automated tests and run existing tests before advancing.

Minimum final verification:

```bash
bun run typecheck
bun test
bun run build
bun run test:e2e
```

Also require:

- clean-directory executable smoke test
- static asset MIME/cache/fallback tests
- authentication failure and SSE retry-stop test
- keyboard-only board/list/detail flows
- responsive checks at narrow and desktop viewports
- light/dark or host-theme checks
- no third-party network requests
- no credentials in logs, screenshots, traces, fixtures, source maps, or artifacts
- a real Chromium browser verification ending in `VERDICT: PASS`
- design review against the Primer-inspired Workboard system before declaring the migration complete

Browser verification must use disposable or read-only data and must not create, edit, or delete durable board data.

## 10. Dependency policy

For every proposed frontend dependency, record:

1. the user-facing or engineering requirement it satisfies
2. why the platform or a small local implementation is insufficient
3. exact pinned version
4. browser bundle impact
5. Bun browser-build compatibility
6. Bun compiled-executable compatibility
7. license suitability
8. security and maintenance implications

Preapproved direction does not mean unlimited dependencies. Preact is the framework choice; everything else requires justification.

## 11. Agent execution rules

- Inspect before editing.
- Preserve established API, authentication, event, and mutation semantics.
- Keep commits phase-scoped and independently verifiable.
- Do not combine the migration with unrelated backend refactors.
- Do not alter durable user data during tests.
- Do not reveal tokens or private item content in logs or artifacts.
- If the current implementation contradicts this document, determine whether it is an established behavior or stale planning text before changing code.
- Update this specification when an accepted implementation decision changes.
- Do not claim completion without the required automated checks, compiled-executable smoke test, design review, and real-browser PASS.

## 12. Final definition of done

The modernization is complete when:

1. Board, list, and detail are implemented in Preact + TypeScript.
2. Bun alone builds browser assets; no Vite or separate frontend server is present.
3. Development and production use the same Workboard server and public route scheme.
4. The UI uses the Workboard-owned Primer-inspired token and component system.
5. The final Bun executable works offline in a clean directory with no external assets.
6. API, MCP, authentication, SSE, backup, and database behavior remain compatible.
7. Legacy manual-rendering modules and obsolete static imports are removed.
8. Typecheck, tests, production build, end-to-end checks, design review, and real-browser verification all pass.
