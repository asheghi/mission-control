# Workboard User Manual

A practical, task-by-task guide to using Agent Workboard — from an empty
directory to a shared board where humans and AI agents work side by side.

Everything here is based on the shipped implementation (CLI `src/cli.ts`,
MCP `src/mcp/tools.ts`, REST `src/api/*`, web UI `src/web/*`).

---

## Table of contents

1. [Concepts](#1-concepts)
2. [Install & build](#2-install--build)
3. [Getting started: your first board](#3-getting-started-your-first-board)
4. [The human loop (Web UI)](#4-the-human-loop-web-ui)
5. [The terminal loop (CLI)](#5-the-terminal-loop-cli)
6. [The agent loop (MCP)](#6-the-agent-loop-mcp)
7. [REST API & live events](#7-rest-api--live-events)
8. [Accounts, tokens & who did what](#8-accounts-tokens--who-did-what)
9. [Operations: serve, backup, restore, doctor](#9-operations-serve-backup-restore-doctor)
10. [Gotchas & FAQ](#10-gotchas--faq)

---

## 1. Concepts

### Participants

Everyone on the board is a **participant** with a `kind`:

| Kind   | Uses                    |
|--------|-------------------------|
| `human` | Web UI (and CLI)       |
| `agent` | MCP tools (Codex, Claude Code, Hermes, …) |

Data-wise an agent is just another row — assignment, @mentions, comments,
and history work identically for both kinds.

### Work items

Each item has a title, a markdown body, a **type** (`feature`, `user_story`,
`bug`, or `task`), a **status**, a **priority** (0–3, default 2; lower = more
urgent), an optional assignee, and optional labels. An item can have a
**parent** (a task must always have one; any type may parent any other) and
non-hierarchical **relationships** to other items (`related`, `predecessor`,
`successor`, `duplicate`, `duplicate_of`). Unfinished siblings sit in an
ordered **backlog** position. Comments thread under the item, and every field
change is recorded in the item's history.

```
todo → doing → done
         └──→ blocked
```

### Identity: how "who did this" is decided

- **Web/REST:** from the presented session/API token — never request data.
- **CLI & stdio MCP:** from the process owner's environment — the
  `--as <participant>` flag or `WORKBOARD_USER` env var, default `local`.
  If no such participant exists yet, one is **created automatically**
  (kind `agent`). So `workboard --as mallory add "X"` makes you `mallory`
  on your first command.

---

## 2. Install & build

Requirements: [Bun](https://bun.sh) 1.4.0.

```bash
bun install          # fetch dependencies (MCP SDK + zod)
bun run build        # single binary → dist/workboard
```

The binary embeds the server, web UI, CLI, and MCP adapter. You can also
run from source with `bun run dev` (watch mode).

Every command accepts a data directory via `--dir <path>` (alias `--data`)
or the `WORKBOARD_DATA_DIR` env var; the default is `./workboard-data`.
The database is one SQLite file, created and migrated on demand — an
explicit `init` is optional but recommended.

---

## 3. Getting started: your first board

```bash
./workboard init                       # data dir + DB + an 'admin' human participant;
                                       # prints that participant's access token once
./workboard serve --port 8765          # Web UI + REST + MCP, prints a sign-in link with
                                       # a self-issued session token
```

Sign in by opening the printed `#token=` link — no extra commands needed.
`init --admin <name>` chooses the default human's name; `init --hide-token`
and `serve --hide-token` suppress token output. Everything below goes
into more detail.

---

## 4. The human loop (Web UI)

Serve the app (§9), then open the URL in a browser.

- **Board view** — one column per status (`todo / doing / blocked / done`).
  - **Drag & drop** items between columns to change status.
  - **Keyboard moves** work too: focus an item and move it without a mouse
    (arrow-style moves through statuses/columns).
  - Click an item to open its detail view.
- **List view** — filter by status, assignee, and label; free-text search;
  cursor-paginated (a "load more"/cursor link appears when more pages
  exist); select multiple items for **bulk assign**.
- **Item detail** — full markdown body (rendered safely), comments with an
  @mention composer (autocomplete of participant names), and the change
  history.
- **Live updates** — the open page subscribes to `/api/events` (SSE) and
  updates itself when anyone (human or agent, over any transport) changes
  something. No refresh needed; keep it open on a secondary screen.

A typical human session: create an item titled "Fix login race", write a
markdown body with acceptance criteria, assign it to `@claude` (an agent
participant), watch it move on the board, and read the agent's completion
comment when it lands.

---

## 5. The terminal loop (CLI)

All commands share the global options below.

### Global options (usable before or after the command)

| Flag / env | Meaning |
|---|---|
| `--dir <path>`, `--data`, `WORKBOARD_DATA_DIR` | Which board to touch |
| `--as <name>` / `WORKBOARD_USER` | Which participant performs the action (auto-creates; default `local`) |
| `--json` | Machine-readable JSON output (every command) |
| `--version`, `-v` | Print version |

### Command reference

**init** — create the data directory, DB schema, and a default human
participant named `admin` (override with `--admin <name>`). On first init it
also issues that participant's access token and prints it once with a
"Store this token now" warning (`--json` includes it as `token`);
`--hide-token` suppresses only the printing — the token still exists and is
never stored in plaintext anywhere. Re-running init is a no-op and prints
nothing sensitive.

```bash
workboard init
workboard init --admin bahman
workboard init --hide-token
```

**add** — create an item.

```bash
workboard add "Fix login race" \
  --body "Steps to reproduce..." \
  --priority 1 \
  --labels bug,auth \
  --assignee claude
```

- `--assignee` takes a participant name, a numeric participant id, or
  `unassigned`.
- `--labels a,b` creates missing labels on the fly with a palette color
  (the REST API requires labels to exist first — the CLI is forgiving).

**list** — query the board.

```bash
workboard list --status doing --assignee claude --label bug --q "login"
```

- Filters: `--status todo|doing|blocked|done`, `--assignee <name|id|unassigned>`,
  `--label <name>`, `--q <text>`, `--limit <1-100>`.
- Paginate: the footer prints `— next page: --cursor <cursor>`; pass that
  value back via `--cursor`.

**view** — one item with comments and field history.

```bash
workboard view 12
```

**update** — patch any combination of fields; only those you pass change.

```bash
workboard update 12 --status doing
workboard update 12 --priority 0 --assignee me
workboard update 12 --type task --parent 7
workboard update 12 --detach             # clear the parent (tasks need one)
workboard update 12 --unassign          # clear the assignee
workboard update 12 --labels bug,p1     # replaces the label set
```

**comment** — add a comment; `@name` mentions notify participants.

```bash
workboard comment 12 "Deployed the fix in 4f2e — @me please verify"
```

**relationship** — non-hierarchical links between items.

```bash
workboard relationship add 12 predecessor 14
workboard relationship remove 12 3
workboard relationship list 12
```

- Names: `related`, `predecessor`, `successor`, `duplicate`, `duplicate_of`.
  Parent/child hierarchy is not a relationship; set it on update.

**reorder** — move an item within sibling backlog order.

```bash
workboard reorder 12 --parent 4 --before 15
workboard reorder 12 --parent 4          # append to the end of #4's children
workboard reorder 12 --parent root       # rejected for tasks
```

**participant** — list, add with `--name <name> --kind human|agent`, or
rename with `participant rename <name> --name <new>` (name comparisons are
case-insensitive; renaming to an existing name is rejected with a clear
conflict error).

```bash
workboard participant
workboard participant add --name codex --kind agent
workboard participant rename bahman --name lead
```

**token** — issue/revoke API tokens (see §8):

```bash
workboard token create --participant claude --name codex-agent
workboard token revoke --id 3
```

**backup / restore / doctor** — see §9.

### Machine-readable output

Any command with `--json` prints a single JSON line suitable for piping:

```bash
workboard --json list --status doing | jq '.items[].title'
workboard --json add "New item" | jq '.item.id'    # capture the id
```

---

## 6. The agent loop (MCP)

Agents get the same board through nine MCP tools. The actor is derived from
the presented credential/context — never from tool arguments — so an agent
cannot act as someone else.

### Two connection modes

**stdio** — one agent, one board, no HTTP. Point the agent's MCP client at:

```bash
workboard mcp --dir /srv/board --as claude
```

(`--as` sets ownership; without it the CLI warns on *stderr* and attributes
work to `local`. All server chatter goes to stderr so stdout stays clean
for JSON-RPC.)

**HTTP** — many agents through the shared server. Issue each agent a token
(§8) and have it call `http://<host>:<port>/mcp` with
`Authorization: Bearer <token>`. The endpoint is **stateless Streamable
HTTP**: each request stands alone, so it survives restarts and reconnects
without session state.

### The nine tools

| Tool | What it does |
|---|---|
| `my_work` | The agent's queue: items assigned to or mentioning it, open items first, then most recently updated. Supports `limit` (1–100) and `cursor`. |
| `list_work` | Filter the board: `type` (`feature|user_story|bug|task`), `status`, `assignee` (name, numeric id, or `"unassigned"`), `label`, `q`, `limit`, `cursor`. Unknown assignee names return an empty result, not an error. |
| `get_work` | One item by numeric `id`, including parent, children, relationships, comments, and history. |
| `create_work` | `title` (required, ≤120 chars), optional `type`, `body` (≤10 000), `priority` 0–3, `assigneeId` (participant id or null), `parentId`, `labels` (array of names — must exist). A `task` requires `parentId`. |
| `update_work` | Partial patch by `id`, including `type` and `parentId`; only provided fields change; `assigneeId: null` unassigns; `parentId: null` moves to root (rejected for tasks); `labels` replaces the whole set. |
| `comment` | Add `body` to item `id`; `@name` mentions surface the item in the mentioned participant's `my_work`. |
| `add_work_relationship` | Add a non-hierarchical relationship relative to `id`: `related`, `predecessor`, `successor`, `duplicate`, or `duplicate_of`. |
| `remove_work_relationship` | Remove one relationship by its id from the selected item. |
| `reorder_work` | Move an item within sibling backlog order: `parentId` (null = root), optional `beforeId` (null = append). Tasks cannot move to root. |

### The loop, concretely

1. Agent calls `my_work` → reads the queue.
2. Picks an item, `update_work { id, status: "doing" }`.
3. Does the work; when done, `comment { id, body: "What I did, @human who asked" }`.
4. `update_work { id, status: "done" }`.

The same flow in reverse (agent creates an item and @mentions a human)
works identically. Humans see all of it live in the Web UI.

---

## 7. REST API & live events

Useful for scripts and integrations. All under the serve command's port.
Authenticated routes accept `Authorization: Bearer <token>` (a synced MCP
HTTP request can also authenticate without carrying tokens through tools —
the credential binds the actor).

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Liveness |
| `GET /api/items` | List (same filters as CLI: `type`, `status`, `assignee`, `label`, `q`, `limit`, `cursor`) |
| `GET /api/backlog` | All unfinished items in backlog order — uncapped, unpaginated |
| `POST /api/items` | Create |
| `GET /api/items/:id` | Detail with parent, children, relationships, comments + history |
| `PATCH /api/items/:id` | Partial update |
| `DELETE /api/items/:id` | Remove |
| `POST /api/items/:id/relationships` | Add a relationship (`related`, `predecessor`, `successor`, `duplicate`, `duplicate_of`) |
| `DELETE /api/items/:id/relationships/:relationshipId` | Remove a relationship |
| `POST /api/items/:id/reorder` | Move within sibling backlog order |
| `POST /api/items/:id/comments` | Comment |
| `GET /api/me/work` | Your own queue (like `my_work`) |
| `GET /api/labels`, `POST /api/labels` | List/create labels |
| `GET /api/participants`, `POST /api/participants` | List/create participants |
| `PATCH /api/participants/:id` | Rename a participant (`{"name": "new"}`) |
| `GET /api/events` | SSE stream of changes (drives the live Web UI) |
| `POST /mcp` | MCP over Streamable HTTP |

Every mutation is attributed to the authenticated actor and recorded in the
item's history; a single request's writes share one timestamp.

---

## 8. Accounts, tokens & who did what

**Participants** live in the DB; add them via CLI
(`participant add --name <n> --kind human|agent`), rename them with
`participant rename <name> --name <new>`, or manage via REST
(`POST /api/participants`, `PATCH /api/participants/:id`). The default
human participant created by `workboard init` is `admin` unless renamed.

**API tokens** authenticate HTTP callers (the web UI also has an
authenticated session flow). Token lifecycle:

```bash
workboard token create --participant claude --name codex-agent
# prints the plaintext once, to stdout; a warning to stderr:
#   "Store this token now; it is not shown again."
workboard token revoke --id 3
```

- `init` (first init) prints the `admin` token the same way, and `serve`
  prints a sign-in link with a self-issued `serve-session` token that is
  revoked when serve exits.
- A token is bound to one participant; whichever token (or session) the
  caller presents becomes the actor.
- Revoking makes it fail immediately (`revoked_at` is set; reuse gives an
  auth error).
- Tokens are stored hashed — losing the plaintext means revoking and
  reissuing, never recovering it.

**Attribution** — comments, updates, history entries, and labels carry the
acting participant's name, whatever transport they used.

---

## 9. Operations: serve, backup, restore, doctor

```bash
workboard serve [--host 127.0.0.1] [--port 8765]
workboard backup [--output file]
workboard restore [--input backup.db] [--force]
workboard doctor [--host <host>] [--port <port>]
```

- **serve**: binds loopback by default (`--host`/`--port`, or
  `WORKBOARD_PORT`). It takes a cooperative PID lock in the data directory;
  if another `serve` already holds it, you get a warning on stderr (SQLite
  tolerates multiple readers, but see restore below). The banner prints a
  `Web UI: http://<host>:<port>/#token=<token>` sign-in link using a
  self-issued `serve-session` token (bound to the `admin` human participant,
  falling back to the first human, then the first participant) that is
  revoked when serve exits. `--token <plaintext>` / `WORKBOARD_TOKEN` supply
  your own token instead; `--hide-token` prints the plain URL only.
- **backup**: a consistent snapshot of the SQLite database
  (default output path derived from the data dir + timestamp).
- **restore**: refuses to overwrite an existing database without `--force`.
  With `--force` it refuses to clobber a **running** `serve` (checks the
  PID lock) — restore while the server runs corrupts the DB, so this is
  guarded. Stop serve first, or pick a fresh directory.
- **doctor**: health checks for data dir, SQLite integrity, schema state,
  foreign keys, row counts, and whether the port is answerable — prints one
  `[ok]/[FAIL]` line per check and exits non-zero when unhealthy. Schedule
  it in cron/CI as your health probe.

Upgrade path: migrate with schema migrations applied idempotently on any
command; a `backup` before upgrading is the cheap safety net.

---

## 10. Gotchas & FAQ

**Q: `workboard --as <name> add …` printed something about creating a participant?**
It auto-created a participant for you (kind `agent`). If that name was
meant for a human, that's fine — the kind is informational, not enforced.
If the name was a typo, you can see it with `participant` and work under
the right one instead.

**Q: My work shows up as "local".**
You didn't pass `--as` or set `WORKBOARD_USER`.

**Q: Where's my data?**
One SQLite file (`workboard.sqlite`) plus WAL files inside the data directory
(default `./workboard-data`; override with `--dir`/`WORKBOARD_DATA_DIR`).

**Q: Why does `restore --force` fail?**
A `serve` process is running against that directory. Stop it, restore,
restart. That guard prevents corrupting a live database.

**Q: Do MCP stdio and HTTP see the same board?**
Yes — both are front-ends to the same SQLite-backed service layer; the
board is the same through Web, CLI, REST, MCP-HTTP, and MCP-stdio.

**Q: Two people edited the same item simultaneously.**
Every change is recorded as history, and updates are field-level patches,
so a comment plus a status change coexist. Frequent edits of the *same*
field become history entries — the last write wins, and the history trail
shows who changed what and when.

**Q: Is the web UI authenticated?**
The server binds to loopback by default. For the web UI in a multi-user
setting, expose it on the network and use per-participant tokens/sessions
(§8); the API layer authenticates every request before any service call.
