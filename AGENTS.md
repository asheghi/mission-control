# AGENTS.md

Instructions for AI agents working in this repository. The README describes the
product; the full usage guide is [docs/manual.md](docs/manual.md). This file
covers what an agent needs to run the board, navigate the code, and verify
changes.

README and docs/manual.md are synced with the work-item model (types,
hierarchy, relationships, ordered backlog) as of 2026-09-26. PLAN.md is a
historical record: its "V1 decisions" pin a six-tool surface that has since
grown to nine. When docs and code disagree, the code under `src/` and this
file are the source of truth.

## Runtime

- Bun-only project, pinned to Bun 1.4.0 (`packageManager` and `engines` in
  `package.json`).
- In sandboxed shells `bun` is usually not on PATH. It is installed at
  `~/.bun/bin/bun`. Prefix commands with:
  `export PATH="$HOME/.bun/bin:$PATH"`.

## Run the dev server

```bash
bun run dev:board
```

- Runs `build:web` first (regenerates `.generated/web-assets.ts`), then
  `scripts/dev.ts`.
- `scripts/dev.ts` is idempotent: `init` migrations, ensures participant `dev`,
  creates a `dev-bootstrap` token, prints a ready-to-open login URL, then
  serves in the foreground.
- Endpoints on the default port:
  - Web UI: `http://127.0.0.1:8765/`
  - Health: `http://127.0.0.1:8765/api/health`
  - MCP: `http://127.0.0.1:8765/mcp`
- Port comes from `--port` or `WORKBOARD_PORT`, default 8765.
- The data dir defaults to the current directory: `workboard.sqlite`
  (plus `-shm`/`-wal`) and `workboard.pid`, all gitignored. Move it with
  `--dir <path>`.
- Before serving, check for a live or stale server with
  `ss -ltnp | grep 8765`. A server already bound to 8765 makes the new bind
  fail with `EADDRINUSE`; `workboard.pid` can point to a dead process.

## Tokens

- Sign-in uses a token in the URL fragment (`/#token=wb_...`). The browser
  adopts it into storage and strips it from the address bar
  (`consumeTokenFromHash` in `src/web/api.js`).
- A token is a live credential scoped to one participant. Never paste a token
  link into chats, issues, screenshots, or commits.
- Tokens persist in the SQLite file, so a server restart keeps existing links
  valid. Each `dev:board` run issues a fresh `dev-bootstrap` token without
  revoking older ones. Revoke explicitly:
  `bun run workboard -- --data <dir> token revoke --id <id>`.

## Use the board as an agent

- MCP endpoint `http://127.0.0.1:8765/mcp` — stateless Streamable HTTP, auth
  via `Authorization: Bearer <token>`. Or stdio: `bun run workboard -- mcp
  --as <name>` (stdout is JSON-RPC; chatter goes to stderr).
- **Nine tools**: `my_work`, `list_work`,
  `get_work`, `create_work`, `update_work`, `comment`,
  `add_work_relationship`, `remove_work_relationship`, `reorder_work`.
- REST and CLI cover the same operations (docs/manual.md §5 and §7).
- Actor comes from the presented credential, never arguments: a token for
  HTTP, `--as <name>` / `WORKBOARD_USER` for CLI and stdio MCP (default
  `local`, auto-created with kind `agent`). Without `--as`, work is attributed
  to `local`.
- MCP tool schemas cap title ≤120 / body ≤10 000, stricter than the domain
  caps (≤256 / ≤100 000) that REST and CLI go through.

## The work-item model

What every transport shares. The zod schemas in `src/domain/validation.ts`
are the contract — when in doubt, read them.

- Status `todo | doing | blocked | done`; priority 0–3 (lower = more urgent).
- Type `feature | user_story | bug | task` (lowercase snake-case). A task
  must always have a parent: create/update reject `task` without `parentId`,
  and reorder refuses to move a task to root. Any type may parent any other
  type.
- Hierarchy is the structural `parentId` link, not a relationship row.
  Non-hierarchical relationships are expressed relative to one item:
  `related | predecessor | successor | duplicate | duplicate_of`.
- Backlog order is `(parent_id, backlog_position, id)` over unfinished items
  (todo/doing/blocked). `GET /api/backlog` returns one uncapped, unpaginated
  envelope of all unfinished items — deliberately never limited; an item cap
  would silently truncate a real backlog.
- CLI syntax: `relationship add <id> <name> <target-id>`,
  `relationship remove <id> <relationship-id>`, `relationship list <id>`,
  `reorder <id> --parent <id|root> [--before <id|end>]`.

## Data directories: know which board you touch

- The database file is always `workboard.sqlite`, plus a `workboard.pid`
  lock file, both inside the data directory.
- The bare CLI (`bun run workboard …`) defaults to `./workboard-data/`;
  `bun run dev:board` overrides that to the repo root. A root board and a
  `workboard-data/` board can therefore exist side by side — they do in this
  checkout.
- Always pass `--data <dir>` / `--dir <dir>` explicitly and match the
  directory of the server you are testing against, or you may read or mutate
  the wrong board.
- The production board is separate again: `dist/workboard serve --dir
  ~/.local/share/workboard` under the systemd user unit `workboard.service`,
  reached by DSH through a preset MCP client with a token from the Host env
  (`WORKBOARD_MCP_TOKEN`). Setup, rotation, and troubleshooting:
  docs/integration/dsh-setup.md. Never print or commit those tokens.

## Repository layout

Strict TypeScript: `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`;
TSX compiles via `jsxImportSource: preact`. There is no lint config and no CI
(no `.github/`) — `bun run typecheck` and `bun test` are the only automated
gates, so run them before calling work done.

- `src/domain/` — pure logic: zod schemas, types, status transitions,
  validation, mention extraction. No DB or I/O here.
- `src/app/` — `WorkboardService`: the one service layer that REST, MCP, and
  the CLI all call; item-query mapping, DTOs, event fan-out.
- `src/db/` — `bun:sqlite` (WAL, `foreign_keys=ON`, `busy_timeout=5000`).
  `repositories/` per aggregate; `migrations/NNN_*.sql` numbered, statically
  imported, applied idempotently on any command (`PRAGMA user_version`).
- `src/api/` — HTTP router, REST endpoints, SSE `/api/events`, stateless MCP
  HTTP adapter, auth middleware.
- `src/auth/`, `src/mcp/` (stdio + the nine tools), `src/cli.ts` (all CLI
  commands), `src/maintenance/` (backup, serve PID lock), `src/observability/`
  (logger, request log, diagnostics).
- `src/web/` — Preact TSX UI. `main.tsx` is the single browser entry;
  `features/` per view (board, backlog, list, detail); `design-system/` CSS
  tokens; a few plain `.js` modules (`api.js`, `ui-state.js`,
  `public-errors.js`) bundle alongside TSX. `scripts/build-web.ts` regenerates
  `.generated/web-assets.ts` (generated, gitignored, never edit) and asserts
  exactly one JS + one CSS output; the server bakes that file in, so a
  rebuilt bundle is served only after the server restarts.
- `test/` — `unit/`, `integration/` (REST, CLI, db, auth), `contract/` (real
  `@modelcontextprotocol/sdk` clients over HTTP and stdio), `e2e/` (compiled
  binary), plus `helpers/` and `fixtures/`.
- Docs: `docs/manual.md` (usage guide), `docs/verification.md` (acceptance
  matrix executed at a past HEAD), `docs/plans/` (implementation plans,
  historical), `docs/integration/` (DSH deployment).

## Verify your changes

```bash
bun run typecheck    # build:web first, then tsc --noEmit
bun test             # build:web first, then the whole suite
bun run build        # compile dist/workboard (single binary)
bun run test:e2e     # only meaningful after build; skips silently otherwise
```

- `test/e2e` exercises the compiled binary from a clean directory and skips
  automatically when `dist/workboard` is missing — a green e2e result with no
  freshly built binary proves nothing.
- Every `build:web` rewrites `.generated/web-assets.ts`, and the e2e suite
  asserts on the served bytes — rerun the build after UI edits.

## Verify UI changes without a desktop browser

The Chrome DevTools MCP can fail with
`Protocol error (Target.setDiscoverTargets): Target closed` when its browser
died. Working fallback from a sandbox (`chromium` lives at `/usr/bin/chromium`):

```bash
chromium --headless=new --disable-gpu --no-sandbox \
  --user-data-dir=.tmp/mcshot/profile \
  --window-size=1440,900 --virtual-time-budget=9000 \
  --screenshot=.tmp/mcshot/mc.png \
  'http://127.0.0.1:8765/#token=<token>#/backlog'
```

A successful render shows the signed-in Backlog page with a green Live
indicator. Data persists across restarts in `workboard.sqlite`.

The shell is branded MissionControl with four views: Backlog (`#/backlog`),
Board (`#/board`), All work (`#/list`), and item detail (`#/item/<id>`).

### Keep the browser alive and control it

The one-shot screenshot command exits immediately, so nothing stays to connect
to. Add `--remote-debugging-port` and keep chromium running; it then speaks the
Chrome DevTools Protocol on `127.0.0.1:9222`:

```bash
chromium --headless=new --disable-gpu --no-sandbox \
  --remote-debugging-port=9222 \
  --user-data-dir=.tmp/mcshot/profile-cdp 'about:blank'
```

- Inspect the endpoint: `curl http://127.0.0.1:9222/json/version`.
- Drive it from any later shell with Playwright:
  `chromium.connectOverCDP("http://127.0.0.1:9222")`. Playwright is installed
  under the mise `npm-playwright` tool (version dir, then
  `node_modules/.mise/playwright@<ver>/node_modules`); point `NODE_PATH` there.
- Verified 2026-09-26: sign in once with a fragment token; later connections
  open the plain URL already signed in (storage adopted in the profile), can
  click through tabs, evaluate JS, and take screenshots. `browser.close()` on a
  CDP connection detaches without killing chromium.
- The session's chrome-devtools MCP launches its own Chrome and cannot attach
  to this instance; Playwright over CDP is the reliable path.

### Closed UI feedback loop

Web assets are baked into the server: `src/web/static-assets.ts` statically
imports `.generated/web-assets`, so a rebuilt bundle is only served after the
server restarts. For iterating on the UI, serve under `bun --watch` instead of
`dev:board`, so every asset rebuild restarts the server automatically:

```bash
bun --watch src/entry.ts serve --data <repo-root> --host 127.0.0.1 --port 8765
```

The loop, verified end to end on 2026-09-26 with a marked edit that appeared
after rebuild and was then reverted:

1. Edit UI source under `src/web/`.
2. `bun run build:web` (regenerates `.generated/web-assets.ts`; `bun --watch`
   restarts the server on the change).
3. Reconnect over CDP, disable cache (`Network.setCacheDisabled` via a CDP
   session), reload the page, and verify: assert text or row counts, capture
   `page.on("console")` errors and failed requests, interact, screenshot.
