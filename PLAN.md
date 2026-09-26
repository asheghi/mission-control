# Implementation Plan

**Product:** A backlog where humans and AI agents are both participants — same
items, same assignment, same @mentions. Humans use a web UI, agents use MCP.

**Stack:** Bun 1.4.0, strict TypeScript, `bun:sqlite`, official MCP SDK,
and a Preact web UI bundled with Bun. The UI uses a small Workboard-owned,
Primer-inspired, CSS-first design system. `bun build --compile` produces one
offline, self-contained executable.

---

## 1. Data model

```sql
participants (id, name, kind, avatar_color, created_at)
  -- kind: 'human' | 'agent'

items (id, title, body, status, priority, assignee_id, created_by,
       created_at, updated_at, closed_at)
  -- status: 'todo' | 'doing' | 'blocked' | 'done'
  -- priority: 0..3

comments (id, item_id, author_id, body, created_at)

mentions (id, item_id, comment_id, participant_id, created_at)
  -- extracted from body text on write, so "what mentions me" is one indexed query

labels (id, name, color)
item_labels (item_id, label_id)

api_tokens (id, participant_id, name, secret_digest, created_at, last_used_at)

history (id, item_id, actor_id, field, old_value, new_value, created_at)
```

SQLite with WAL, `foreign_keys=ON`, `busy_timeout=5000`. Numbered migrations
embedded in the binary, tracked via `PRAGMA user_version`.

Actor comes from the API token, never from the request body — so history and
"who assigned this" are accurate. That is attribution among cooperating
participants, not tamper-proofing.

---

## 2. API

```
GET    /api/items?status=&assignee=&label=&q=
POST   /api/items
GET    /api/items/:id            → item + comments + history
PATCH  /api/items/:id            → title, body, status, priority, assignee, labels
DELETE /api/items/:id

POST   /api/items/:id/comments

GET    /api/me/work              → assigned to me + mentioning me, open first
GET    /api/participants
POST   /api/participants         → register an agent
GET    /api/labels
GET    /api/events               → SSE for live board updates
```

`PATCH` takes only the fields being changed, so two people editing different
fields of one item don't clobber each other.

Optional convenience: `POST /api/items/next?assign_to=me` for an agent that
wants unassigned work. Because two agents could call it at once, it uses a
single guarded statement rather than select-then-update:

```sql
UPDATE items SET assignee_id = :me, status = 'doing', updated_at = :now
WHERE id = (SELECT id FROM items
            WHERE status = 'todo' AND assignee_id IS NULL
            ORDER BY priority DESC, created_at ASC LIMIT 1)
  AND assignee_id IS NULL
RETURNING *;
```

Everything else is ordinary CRUD — when work is assigned, there is nothing to
race for.

---

## 3. MCP tools

The agent's whole interface. Thin wrappers over the REST API:

| Tool | Purpose |
|------|---------|
| `my_work` | What's assigned to me or mentions me — the session-start call |
| `list_work` | Filter by status, assignee, label, text |
| `get_work` | One item with comments |
| `create_work` | File a new item, optionally assigning a human |
| `update_work` | Status, assignee, priority, labels |
| `comment` | Add a comment, `@name` mentions resolve to participants |

Tool descriptions tell the agent the conventions: set `doing` when starting,
comment what you did before setting `done`, use `blocked` and @mention a human
when stuck.

---

## 4. Web UI

- **Board** — four columns (`todo`, `doing`, `blocked`, `done`), drag to move.
- **List** — filterable table, bulk assign.
- **Item detail** — body, comments, history, assign dropdown (humans and agents
  in one list), label picker.
- **Composer** — `@` autocompletes over all participants.

Agents get a visible marker in the assignee dropdown and on cards, so you can
see at a glance what is being worked by whom.

Live updates use SSE. The target component architecture is Preact + TypeScript,
built with Bun's browser bundler and served by the existing Workboard server in
both development and production. There is no Vite server, runtime CDN, or
production dependency on `node_modules` or external web assets.

The UI uses semantic CSS custom properties and a small Workboard-owned design
system, with GitHub Primer Product as the visual and interaction reference.
Design-system primitives remain separate from board/list/detail product
components. Markdown keeps raw HTML disabled and allows only `http`, `https`,
`mailto`, and relative URLs.

The incremental migration and acceptance criteria are specified in
`docs/plans/web-ui-modernization.md`.

---

## 5. Build order

**Phase 1 — Core + API.** Schema, migrations, REST endpoints, token auth,
participants. Tests against a disk-backed database.

**Phase 2 — MCP adapter.** The six tools, verified by pointing a real Codex or
Claude Code session at the compiled binary and having it work an item end to
end.

**Phase 3 — Initial Web UI.** Board, list, detail, mentions, and SSE against the
compiled binary, including a Markdown XSS corpus. The existing vanilla modules
satisfy this initial product phase.

**Phase 4 — Polish.** CLI, backup/restore, `workboard doctor`, structured logs.

**Phase 5 — Web UI modernization.** Incrementally migrate the working UI to
Preact + TypeScript, bundled by Bun and embedded in the same executable. Add the
Workboard-owned Primer-inspired design system without changing the server
runtime topology or public route scheme. Follow
`docs/plans/web-ui-modernization.md`; do not perform a flag-day rewrite.

---

## 6. Open questions

1. Should `done` items disappear from the board after N days, or need an
   explicit archive?
2. Do agents need to be notified when assigned something mid-session, or is
   checking `my_work` at session start enough?
3. One board per project directory, or projects as a column in one database?

---

## 7. V1 decisions

Implementation proceeds with these defaults:

1. One board per data directory and SQLite database.
2. Done items are retained; the board may show a bounded recent subset while the list exposes all.
3. Agents discover assignments through `my_work`; MCP push notifications are deferred.
4. Participants use immutable ASCII handles in v1.
5. Authentication is cooperative attribution: every authenticated participant may manage work; token issuance is an administrative CLI operation.
6. Item deletion is hard deletion in v1 and requires confirmation in the web UI.
7. Concurrent patches to different fields are preserved; same-field updates are last-write-wins.
8. Mentions in Markdown code spans and fenced code count in v1 because mention extraction scans raw text.
9. The public MCP surface is exactly the six tools listed above; `claim_next`
   remains deferred. (Superseded 2026-09: the shipped surface is nine tools —
   relationship add/remove and reorder joined with the work-item model; see
   AGENTS.md.)
10. HTTP MCP is protocol-stateless. Compatibility with the MCP revision supported by the real DSH client takes priority over targeting an unverified newer wire revision.
11. Workboard binds to loopback by default. Remote exposure requires explicit host/origin settings and TLS at a trusted reverse proxy.
