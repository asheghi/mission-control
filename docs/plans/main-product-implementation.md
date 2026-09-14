# Agent Workboard: Main Product Implementation Plan

> **Frontend update:** The initial vanilla web UI is implemented. For the next
> frontend architecture, build, design-system, migration, and completion
> contract, `docs/plans/web-ui-modernization.md` supersedes the frontend-specific
> guidance in this historical main-product plan.

## 0. Instructions for the implementing model

This plan is intentionally explicit so a cheaper coding model can execute it one task at a time.

Rules:

1. Read `README.md`, `PLAN.md`, and `docs/research/stateless-mcp.md` before changing code.
2. Execute tasks in numbered order. Do not combine phases.
3. At the start of each task, inspect every file named by that task.
4. Make the smallest change that satisfies that task.
5. Run the listed verification commands immediately.
6. If verification fails, fix it before advancing.
7. Do not change an established API, schema, or invariant without updating its contract test and this document.
8. Keep all user-facing text in English.
9. Do not add sprints, epics, story points, custom workflows, a permissions matrix, or Git integration.
10. Do not hand-roll MCP JSON-RPC. Use the pinned official MCP TypeScript SDK.

## 1. Product boundary

Build one local-first executable that provides:

- A Kanban board and list view for humans.
- A REST API used by the web UI and CLI.
- An MCP server used by agents.
- A CLI used by scripts and terminal users.
- One SQLite database directory containing durable data.

Initial statuses are `todo`, `doing`, `blocked`, and `done`. Participants are either `human` or `agent`, but assignment, mentions, comments, and history behave identically for both.

### Explicit non-goals

- Multiple projects in one database.
- Fine-grained authorization roles.
- Git provider integration.
- Agent execution inside Workboard.
- Stateful MCP sessions, MCP sampling/elicitation, or legacy HTTP+SSE.
- Multi-host access to one SQLite file.
- Arbitrary workflow configuration.

## 2. Architectural invariants

1. **One application layer:** REST, CLI, stdio MCP, and HTTP MCP call the same service methods.
2. **Authenticated actor:** mutation methods receive an actor from trusted transport context. Request bodies and MCP arguments never choose the actor.
3. **Transactional mutations:** primary write, mention extraction, and history insertion commit or roll back together.
4. **Transport independence:** application modules do not import HTTP, MCP, Preact, or CLI libraries.
5. **Stable contracts:** transport schemas map explicitly to owned DTOs; never expose database rows directly.
6. **Safe markdown:** raw HTML is disabled and links allow only `http`, `https`, `mailto`, and relative URLs.
7. **Stateless MCP HTTP:** `/mcp` keeps no protocol session. Prefer modern MCP 2026-07-28 when the real DSH client supports it; otherwise use the official 2025-era stateless compatibility pattern without issuing `MCP-Session-Id`.
8. **Local-first security:** bind to `127.0.0.1` unless explicitly configured otherwise.
9. **Deterministic migrations:** migrations are numbered, embedded, transactional, and tracked by `PRAGMA user_version`.
10. **One executable:** the production build embeds web assets and migrations.

## 3. Target repository layout

Create this structure gradually; do not create empty placeholder files unrelated to the current task.

```text
agent-workboard/
├── README.md
├── PLAN.md
├── package.json
├── bun.lock
├── tsconfig.json
├── components.json
├── scripts/
│   └── build.ts
├── src/
│   ├── entry.ts
│   ├── config.ts
│   ├── domain/
│   │   ├── types.ts
│   │   ├── errors.ts
│   │   ├── transitions.ts
│   │   └── mentions.ts
│   ├── db/
│   │   ├── database.ts
│   │   ├── migrate.ts
│   │   ├── schema.ts
│   │   └── migrations/
│   │       └── 001_initial.sql
│   ├── app/
│   │   ├── dto.ts
│   │   ├── participants.ts
│   │   ├── labels.ts
│   │   ├── items.ts
│   │   ├── comments.ts
│   │   ├── tokens.ts
│   │   └── workboard.ts
│   ├── auth/
│   │   ├── tokens.ts
│   │   └── middleware.ts
│   ├── api/
│   │   ├── router.ts
│   │   ├── response.ts
│   │   ├── validation.ts
│   │   ├── items.ts
│   │   ├── participants.ts
│   │   ├── labels.ts
│   │   ├── events.ts
│   │   └── mcp-http.ts
│   ├── mcp/
│   │   ├── schemas.ts
│   │   ├── register-tools.ts
│   │   ├── result.ts
│   │   ├── stdio.ts
│   │   └── streamable-http.ts
│   ├── cli/
│   │   ├── cli.ts
│   │   ├── output.ts
│   │   └── commands/
│   └── web/
│       ├── index.html
│       ├── main.tsx
│       ├── app.tsx
│       ├── api.ts
│       ├── types.ts
│       ├── styles.css
│       ├── routes/
│       ├── components/
│       └── hooks/
└── test/
    ├── helpers/
    ├── unit/
    ├── integration/
    ├── contract/
    ├── e2e/
    └── fixtures/
```

## 4. Pinned technology choices

During Task 1, determine and pin exact compatible versions; never leave core dependencies as `latest`.

- Runtime/package manager/test runner: Bun 1.4.x.
- Language: strict TypeScript.
- Database: `bun:sqlite` only.
- MCP: official `@modelcontextprotocol/sdk`, exact tested version.
- Validation: Zod version compatible with the selected MCP SDK.
- UI modernization: Preact + TypeScript, bundled for browsers with Bun and served by the existing Workboard server.
- Design system: Workboard-owned semantic CSS tokens and local components, using GitHub Primer Product as the reference.
- Routing and state: begin with owned lightweight modules and Preact hooks; add no router, query library, or drag/drop dependency without a demonstrated requirement.
- Markdown: use an owned or narrowly selected renderer with a constrained URL transform; raw HTML must not be enabled.
- Frontend runtime dependencies: locally installed, exactly pinned, and embedded; no CDN and no separate development server.
- E2E: Playwright.
- Password/token hashing: use a Bun-supported cryptographic primitive; store a keyed digest or password hash, never the plaintext token.

Avoid adding an HTTP framework unless the Bun-native router becomes materially complicated. If one is chosen, document why and prove `bun build --compile` compatibility before broad use.

## 5. External contracts

### 5.1 Domain enums

```text
ParticipantKind = human | agent
WorkStatus = todo | doing | blocked | done
Priority = 0 | 1 | 2 | 3
```

Priority meaning:

- `0`: none
- `1`: low
- `2`: normal
- `3`: high

### 5.2 Required REST API

```text
GET    /api/health
GET    /api/items?status=&assignee=&label=&q=&limit=&cursor=
POST   /api/items
GET    /api/items/:id
PATCH  /api/items/:id
DELETE /api/items/:id
POST   /api/items/:id/comments
GET    /api/me/work
GET    /api/participants
POST   /api/participants
GET    /api/labels
POST   /api/labels
GET    /api/events
POST   /mcp
GET    /mcp       (only if required by chosen Streamable HTTP behavior; otherwise method-not-allowed)
DELETE /mcp       (stateless mode returns method-not-allowed)
```

All `/api` and `/mcp` routes except health and static web assets require authentication. If product bootstrap needs an unauthenticated first-user path, implement it as a one-time CLI command rather than an open HTTP endpoint.

### 5.3 Required MCP tools

- `my_work`
- `list_work`
- `get_work`
- `create_work`
- `update_work`
- `comment`

Optional only after required tools pass: `claim_next`.

Tool output must contain compact structured content and useful text content. IDs are integers everywhere. Date/time values are UTC ISO-8601 strings at transport boundaries.

### 5.4 CLI surface

```text
workboard serve --dir <path> --host 127.0.0.1 --port 8765
workboard mcp --dir <path> --token <token-or-env>
workboard participant add --dir <path> --name <name> --kind human|agent
workboard token create --dir <path> --participant <name> --name <label>
workboard token revoke --dir <path> --id <id>
workboard item list|get|create|update
workboard comment add
workboard backup --dir <path> --output <file>
workboard restore --dir <path> --input <file>
workboard doctor --dir <path>
workboard --version
```

Token creation prints a plaintext token exactly once.

## 6. Database schema

Migration `001_initial.sql` creates:

### participants

- `id INTEGER PRIMARY KEY`
- `name TEXT NOT NULL COLLATE NOCASE UNIQUE`
- `kind TEXT NOT NULL CHECK(kind IN ('human','agent'))`
- `avatar_color TEXT NOT NULL`
- `created_at TEXT NOT NULL`

### items

- `id INTEGER PRIMARY KEY`
- `title TEXT NOT NULL`
- `body TEXT NOT NULL DEFAULT ''`
- `status TEXT NOT NULL DEFAULT 'todo' CHECK(...)`
- `priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 0 AND 3)`
- `assignee_id INTEGER NULL REFERENCES participants(id) ON DELETE SET NULL`
- `created_by INTEGER NOT NULL REFERENCES participants(id)`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `closed_at TEXT NULL`

### comments

- `id INTEGER PRIMARY KEY`
- `item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE`
- `author_id INTEGER NOT NULL REFERENCES participants(id)`
- `body TEXT NOT NULL`
- `created_at TEXT NOT NULL`

### mentions

- `id INTEGER PRIMARY KEY`
- `item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE`
- `comment_id INTEGER NULL REFERENCES comments(id) ON DELETE CASCADE`
- `participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE`
- `created_at TEXT NOT NULL`
- uniqueness preventing duplicate mention records for the same source and participant

### labels and item_labels

- `labels(id, name UNIQUE COLLATE NOCASE, color, created_at)`
- `item_labels(item_id, label_id, PRIMARY KEY(item_id,label_id))`

### api_tokens

- `id INTEGER PRIMARY KEY`
- `participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE`
- `name TEXT NOT NULL`
- `token_prefix TEXT NOT NULL`
- `secret_digest TEXT NOT NULL UNIQUE`
- `created_at TEXT NOT NULL`
- `last_used_at TEXT NULL`
- `revoked_at TEXT NULL`

### history

- `id INTEGER PRIMARY KEY`
- `item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE`
- `actor_id INTEGER NOT NULL REFERENCES participants(id)`
- `field TEXT NOT NULL`
- `old_value TEXT NULL`
- `new_value TEXT NULL`
- `created_at TEXT NOT NULL`

Add indexes for item status/update time, assignee/status, comments by item/time, mentions by participant/item, labels by name, history by item/time, and token digest.

Store label assignment changes in history using stable JSON arrays of label IDs or one event per add/remove; choose one and contract-test it.

## 7. Ordered implementation tasks

### Task 1 — Bootstrap and compatibility spike

Create `package.json`, `tsconfig.json`, minimal source/test files, and scripts for `dev`, `typecheck`, `test`, `build`, and `test:e2e`.

Required spike:

- Open an in-memory `bun:sqlite` database.
- Start a minimal official-SDK MCP server over stdio in a test.
- Start a minimal stateless Streamable HTTP endpoint in a test.
- Test the exact MCP client generation used by the installed DSH bridge first; record the negotiated protocol revision.
- If it is a 2025-era client, initialize, list one tool, call it, and confirm no response issues `MCP-Session-Id`.
- If both ends support MCP 2026-07-28, verify per-request metadata/discovery and confirm no protocol session exists.
- Compile a minimal executable.

Acceptance:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test test/contract/mcp-spike.test.ts
bun run build
./dist/workboard --version
```

Record selected exact versions in `package.json`. If the HTTP SDK adapter fails under Bun, create one narrow adapter module and test it; do not hand-code MCP.

### Task 2 — Domain primitives

Implement enums, ID types/aliases, error classes/codes, transition policy, time abstraction, and mention parsing.

Mention rules:

- Recognize `@name` on token boundaries.
- Resolve case-insensitively against existing participants.
- Unknown names remain plain text.
- Each participant produces at most one mention per source.
- Avoid matching email-domain fragments.

Status rules for v1: allow any listed status to any other listed status, but set `closed_at` on entering `done` and clear it on leaving `done`. Centralize this behavior so it can tighten later.

Acceptance: table-driven unit tests for every enum validator, transition, close/reopen timestamp behavior, and mention edge case.

### Task 3 — Database initialization and migration runner

Implement safe data-directory creation, database opening, pragmas, migration loading, and transaction handling.

On every connection assert:

```text
foreign_keys=ON
journal_mode=WAL
busy_timeout=5000
```

Migration behavior:

- Read `user_version`.
- Apply missing numbered migrations in order.
- Wrap each migration in a transaction.
- Set `user_version` only after successful SQL.
- Reject a database newer than the executable.
- Running migration twice is a no-op.

Acceptance: tests against temporary disk databases for fresh create, reopen, rollback on invalid migration, and newer-version rejection.

### Task 4 — Repositories and DTO mapping

Implement internal SQL repository functions and explicit row-to-DTO mappers. Keep SQL in `src/db` or clearly named repository modules; do not scatter SQL through routes.

Required queries:

- participant get/list/create
- label get/list/create
- token create/find/revoke/touch
- item create/get/list/update/delete
- comment create/list
- mention replace/query
- history append/list
- `my_work` union/deduplication query

Pagination must be deterministic. Use `(updated_at, id)` or `(created_at, id)` cursor ordering and document its encoded shape.

Acceptance: disk-backed integration tests for every query, foreign keys, cascades, pagination stability, case-insensitive participant names, and indexes via schema assertions.

### Task 5 — Authentication service

Generate tokens with enough random entropy, display once, store only prefix and digest, and compare safely. Resolve a token to an immutable actor.

Transport code passes credentials to authentication. Application mutation calls accept `Actor`, not a token string.

Acceptance:

- plaintext token absent from the database
- valid token resolves correct participant
- malformed, unknown, and revoked tokens fail identically
- actor spoof fields are absent from all public mutation schemas
- last-used timestamp changes without altering attribution

### Task 6 — Application service

Implement `WorkboardService` as the only supported business entry point.

Required methods:

```text
listItems(actor, filter)
getItem(actor, id)
createItem(actor, input)
updateItem(actor, id, patch)
deleteItem(actor, id)
addComment(actor, itemId, input)
myWork(actor, filter?)
listParticipants(actor)
createParticipant(actor, input)
listLabels(actor)
createLabel(actor, input)
```

Every mutation performs validation and related writes in one transaction. `PATCH` changes only supplied fields. Distinguish missing from explicit null for assignee.

History requirements:

- Record creation.
- Record each changed scalar field.
- Do not write no-op changes.
- Record label and assignee changes.
- Actor always comes from trusted context.

Acceptance: service-level contract tests with no HTTP/MCP imports; rollback test forces an error during mention/history insertion and confirms no partial write.

### Task 7 — Event broker

Create an in-process event broker for browser SSE. Publish compact events only after a database transaction commits.

Event shape:

```json
{
  "id": "monotonic-process-id",
  "type": "item.created|item.updated|item.deleted|comment.created|participant.created|label.created",
  "itemId": 123,
  "occurredAt": "UTC ISO timestamp"
}
```

SSE reconnect can trigger a full query refresh; durable replay is not required in v1. Bound subscriber queues and disconnect slow consumers.

Acceptance: tests prove no event on rollback, event after commit, unsubscribe cleanup, heartbeat cleanup, and bounded queue behavior.

### Task 8 — REST API

Implement router, bearer authentication middleware, parsing limits, validation, stable error mapping, and all required endpoints.

Response conventions:

- success: `{ "data": ..., "meta": ... }`
- error: `{ "error": { "code": "...", "message": "...", "details"?: ... } }`
- attach/request a correlation ID
- JSON content type on JSON responses

HTTP mapping:

- validation → 400
- unauthenticated → 401
- forbidden/origin rejection → 403
- not found → 404
- conflict → 409
- unexpected → 500 with generic public message

Acceptance: black-box HTTP tests for every endpoint, invalid inputs, missing/revoked token, body-size limit, query pagination, concurrent different-field patches, and actor spoof attempts.

### Task 9 — Stateless Streamable HTTP MCP

Implement `/mcp` using the official SDK and the findings in `docs/research/stateless-mcp.md`.

Requirements:

- One endpoint.
- POST support required.
- No generated session ID.
- No in-memory client-session map.
- Authenticate each HTTP request.
- Validate `Origin` against configured allowlist when present.
- Bind localhost by default.
- Register exactly the six required tools.
- Do not advertise sampling, elicitation, subscriptions, or resumability.
- Apply request timeout and cancellation.
- Map domain errors to safe MCP tool errors.

Acceptance:

- the actual DSH client lists and calls all tools using its supported protocol revision
- 2025-era mode initializes but no response includes `MCP-Session-Id`; modern 2026-07-28 mode uses per-request protocol metadata and no initialization session
- calls succeed without a session header in either mode
- independent clients with different tokens retain correct attribution
- server restart between calls preserves database results
- invalid origin and token fail
- malformed JSON-RPC is handled by SDK

### Task 10 — stdio MCP

Use the same `register-tools.ts` and service contracts. The stdio process must write protocol data only to stdout; logs go to stderr.

Identity must be provided by a token option or `WORKBOARD_TOKEN`. Reject startup without identity.

Acceptance:

- official client starts child and calls every tool
- stdout contains no logs
- SIGTERM/EOF closes database and exits
- tool schemas and results match HTTP MCP contract snapshots

### Task 11 — CLI

Implement argument parsing and commands. CLI commands call the application service directly, not local HTTP, except where explicitly documented.

Human-readable output is default for terminal use; `--json` prints stable JSON to stdout. Errors go to stderr and set nonzero exit codes.

Acceptance: subprocess tests for help, version, participant/token bootstrap, item lifecycle, comments, JSON output, invalid arguments, and secret-print-once behavior.

### Task 12 — Static web shell and API client

The initial dependency-free web shell is implemented. Its modernization is governed by `docs/plans/web-ui-modernization.md`.

Target architecture:

- Preact + TypeScript/TSX.
- Bun browser-target build; no Vite or separate frontend development server.
- Same Workboard HTTP server and public routes in development and production.
- Workboard-owned semantic CSS tokens and small Primer-inspired component set.
- Typed API client and one owned SSE lifecycle.
- Locally bundled dependencies and assets; no runtime CDN.

Routes:

- `/` board
- `/list` list view
- `/items/:id` item detail modal/page
- `/settings/participants` minimal participant/token administration if included

Authentication for v1 may use a token stored in memory/session storage. Do not put tokens in URLs. Document the threat model and provide logout/clear behavior.

Acceptance: the Bun production web bundle builds before executable compilation; the same server serves development and production routes; SPA fallback does not shadow `/api`, `/mcp`, `/healthz`, or SSE; API errors render safely in English; keyboard focus is visible; and the executable works offline without external assets or `node_modules`.

### Task 13 — Board view

Build four columns and cards showing title, priority, labels, assignee, comment count, and agent marker. Add drag/drop status movement with optimistic update and rollback on API failure.

Requirements:

- keyboard-accessible alternative to dragging
- clear empty/loading/error states
- done-column retention policy: show recent done items with a documented filter rather than deleting them
- responsive horizontal behavior

Acceptance: component tests plus Playwright create → assign → drag → persisted refresh flow.

### Task 14 — List view

Build filterable table with status, assignee, label, and text search. Add stable pagination and bulk assignment only after single-item flows pass.

Acceptance: URL-backed filters, keyboard operation, empty/error/loading states, pagination without duplicates, bulk assignment history correctness.

### Task 15 — Item detail and composer

Implement editable title/body/status/priority/assignee/labels, rendered markdown, comments, and history. Add `@` participant autocomplete in item body/comment composer.

Security:

- raw HTML disabled
- URL allowlist enforced
- external links use safe rel attributes
- large bodies constrained

Acceptance:

- markdown XSS corpus causes no script execution or unsafe URL
- mention autocomplete includes human and agent participants
- comment author always matches token actor
- history displays every change in order
- concurrent different-field edits do not clobber each other

### Task 16 — Browser live updates

Connect to `/api/events`; on relevant events invalidate precise queries. Reconnect with capped backoff. Avoid duplicating optimistic mutations.

Acceptance: two browser contexts; a mutation in one appears in the other without refresh; disconnect/reconnect leaves no duplicate listeners and converges through refetch.

### Task 17 — Backup, restore, and doctor

Backup must use a SQLite-consistent mechanism rather than copying a live WAL-backed file naively. Restore validates format and refuses to overwrite without an explicit flag.

`doctor` checks:

- data-directory access
- database open/integrity
- migration version
- foreign-key check
- token/participant counts without leaking secrets
- configured host/port availability where appropriate

Acceptance: write data, backup, restore into a new directory, compare public data; corrupted backup fails safely; doctor exit codes distinguish healthy/unhealthy.

### Task 18 — Production build

Run the Bun browser-target build first, then bundle the server, CLI, migrations, and generated web assets into one Bun-compiled executable. Runtime must not depend on source files, `node_modules`, an external asset directory, a CDN, or a separate frontend server. The browser asset pipeline must follow `docs/plans/web-ui-modernization.md`.

Acceptance in a clean temporary directory:

```bash
./workboard --version
./workboard participant add --dir ./wb_data --name admin --kind human
./workboard token create --dir ./wb_data --participant admin --name bootstrap
./workboard serve --dir ./wb_data --port 8765
```

Then verify health, web load, REST, and MCP using only the executable.

### Task 19 — Complete verification matrix

Run:

```bash
bun run typecheck
bun test
bun run build
bun run test:e2e
```

Required additional checks:

- Fresh-database migration.
- Upgrade fixture migration when migration 002 exists.
- Real DSH MCP client integration.
- REST/MCP/CLI parity for one full item lifecycle.
- Markdown XSS corpus.
- Two-client actor attribution.
- SIGTERM graceful shutdown.
- No plaintext test or real tokens in logs/database snapshots.

Do not declare completion if any required check is skipped. Record command, exit code, and concise output in `docs/verification.md`.

## 8. Tool schemas

Define schemas once in `src/mcp/schemas.ts`. Exact field descriptions should teach an agent correct workflow.

### my_work

Input: optional `status`, `limit`, `cursor`. Output: assigned or mentioned open items first, deduplicated by item ID, with reason flags `assigned` and/or `mentioned`.

### list_work

Input: optional status array, assignee ID/name, label ID/name, text query, limit, cursor. Output: summaries plus next cursor.

### get_work

Input: item ID. Output: item, labels, assignee, comments with authors, and ordered history.

### create_work

Input: title, optional body, priority, assignee, labels. The actor is not accepted. Output: created detail.

### update_work

Input: item ID plus at least one patch field. Omitted means unchanged; explicit null only allowed for assignee. Output: updated detail and changed field names.

### comment

Input: item ID and nonblank body. The author is not accepted. Output: created comment and resolved mention participants.

Every schema sets sensible maximum lengths and rejects unknown fields where SDK support permits it.

## 9. Security checklist

- [ ] Actor is derived from token in every transport.
- [ ] Token plaintext is never persisted or logged.
- [ ] SQL uses parameters; no string interpolation.
- [ ] Raw HTML markdown is disabled.
- [ ] URL schemes are allowlisted.
- [ ] HTTP body, query, and output sizes are bounded.
- [ ] `/mcp` validates Origin and authentication.
- [ ] Default host is loopback.
- [ ] Secrets do not appear in thrown public errors.
- [ ] Backup is consistent with WAL.
- [ ] All mutation-related records share a transaction.
- [ ] SSE subscribers and MCP request objects dispose cleanly.

## 10. Definition of done

The main product is done only when a clean-machine test can:

1. Build one executable.
2. Initialize a new data directory.
3. Create a human and agent participant and their tokens.
4. Start the web/API/MCP server.
5. Create and assign an item in the browser.
6. Retrieve it via stateless MCP as the agent.
7. Set it to doing, add a comment, and set it to done.
8. Observe each update live in a second browser context.
9. Verify history attributes every change to the correct participant.
10. Backup and restore the resulting database.
11. Pass typecheck, unit, integration, contract, security, and Playwright suites.

## 11. Decisions that must be frozen before schema/API implementation

Task 1 must record explicit answers in `PLAN.md`; a cheaper model must not silently invent them later:

1. One board per data directory versus multiple projects. Default: one board per directory.
2. Done-item retention. Default: never auto-delete; cap the board view and expose all in list view.
3. Mid-session agent assignment notification. Default: agents poll `my_work`; browser alone uses SSE.
4. Browser authentication. Decide API-token-only versus an HttpOnly web-session exchange with CSRF protection before routes are frozen.
5. Cooperative authorization. Default: every authenticated participant can mutate items; token issuance remains local administration.
6. Participant identity. Default: immutable ASCII handle; add a separate display name now if Unicode/renames are required.
7. Mention parsing in Markdown code spans/fences. Choose and test one rule.
8. Hard delete versus durable audit. Default plan uses hard delete; switch to tombstones before migration 001 if deleted history must survive.
9. Same-field concurrent edits. Default: last write wins; add `version`/`If-Match` before API freeze if lost-update detection is required.
10. Label administration. Decide whether v1 needs web/API CRUD or local CLI administration only.
11. Optional `claim_next`. Do not expose an accidental seventh MCP tool.
12. MCP wire era. Test the actual DSH bridge: prefer modern 2026-07-28 only when supported, otherwise ship 2025-era stateless compatibility.
13. CLI architecture. Decide whether stdio MCP/remote CLI call REST or open SQLite directly; use one consistent documented rule per command.
14. Remote deployment. Define trusted proxy, public origin, TLS, and Host handling before allowing a non-loopback bind.
15. Backup API. Prove Bun’s SQLite backup behavior; otherwise require a documented maintenance stop rather than copying a live WAL file.
