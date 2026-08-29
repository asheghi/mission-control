# Agent Workboard — Implementation Plan

**Product:** A local-first work queue for one repository, coordinating 2–10 coding
agents and one human, with recoverable exclusive claims and durable progress.

**Architecture:** One SQLite-owning server binary. Web, CLI, and MCP are clients
of the same REST API.

**Stack:** Bun 1.4.0 (verified on this machine), TypeScript strict, `bun:sqlite`,
official MCP SDK, Zod for runtime schemas.

**Status:** Draft 2. Rewritten after review — the previous plan front-loaded a
design system and monorepo governance and did not deliver an agent-usable tool
until Phase 6. This plan delivers the agent workflow first and treats everything
else as unearned until dogfooding proves the tool is worth using.

---

## 1. What changed and why

The v1 plan was, accurately, "a design-system monorepo wearing an issue tracker
name tag." Corrections applied:

| # | Problem | Fix |
|---|---------|-----|
| 1 | Claiming had no lease — a crashed agent stranded work forever | Exclusive lease with token, expiry, renew, release, recovery sweep (§4) |
| 2 | No idempotency or concurrency contract; agent retries would duplicate or clobber | `Idempotency-Key` + `If-Match` revisions + stable error codes (§5) |
| 3 | Order maximized sunk cost | Vertical slice in Phase 1; dogfood gate before anything else (§8) |
| 4 | HTMLRewriter denylist proposed as a sanitizer | Raw HTML disabled in markdown entirely (§6) |
| 5 | "Zero dependencies" conflated with zero *deployment* dependencies | Official MCP SDK; `--compile` bundles it (§7) |
| 6 | Tokens not bound to identity — audit trail spoofable | Tokens carry participant + scopes; actor never client-supplied (§7) |
| 7 | `blocked` was both a workflow state and derived | Status and blocking are separate axes (§3) |
| 8 | Single-writer contradicted `migrate`/`backup`/`token` | Admin API + explicit offline mode (§9) |
| 9 | Done meant "implemented", not "useful" | Dogfood gate with a stop condition (§8, Phase 2) |
| 10 | In-memory tests didn't exercise WAL, restart, or contention | Disk-backed tests, real processes, restart and migration tests (§10) |

**Deferred until after the dogfood gate:** themes and theming presets, component
playground, custom visual ESLint rules, Hermes mention notifications, unlimited
hierarchy, multi-project support, Windows service lifecycle, cross-compilation
beyond the dev platform.

**On the design system** — you asked for one explicitly, and I am not silently
dropping it. I am deferring the *governance* (themes, playground, lint rules) to
Phase 5 while keeping the *seam* from day one: every web component is imported
from `packages/ui`, even in Phase 3 where they're stock shadcn with default
tokens. Retrofitting a theme onto that is a token-file change. Retrofitting it
onto ad-hoc page markup is a rewrite. If you'd rather have the full design system
before the board ships, say so — it's your call, not the reviewer's.

---

## 2. Layout

Bun workspaces. No Turborepo yet — at four packages, `bun run --filter` is
sufficient; adding it later is trivial and adding it now is one more thing to
learn before the tool exists.

```
agent-workboard/
├── apps/
│   ├── server/       # Bun.serve + SQLite owner → compiles to ./workboard
│   ├── cli/          # REST client
│   ├── mcp/          # official MCP SDK over stdio → REST client
│   └── web/          # Phase 3
├── packages/
│   ├── core/         # domain + SQLite. SERVER ONLY
│   ├── client/       # typed REST SDK + Zod schemas, shared by all clients
│   └── ui/           # Phase 3, stock shadcn
└── package.json
```

`packages/client` holds the Zod schemas. Server validates inbound with them,
clients derive types from them — one definition, no drift.

---

## 3. Data model

SQLite, WAL, `foreign_keys=ON`, `synchronous=NORMAL`. Migrations are numbered SQL
embedded in the binary, applied in a transaction, tracked with `user_version`.

**`work_items`**

| Column | Notes |
|--------|-------|
| `id` | integer pk |
| `title`, `body` | body is markdown |
| `status` | `ready` \| `doing` \| `review` \| `done` |
| `priority` | 0–3, higher first |
| `revision` | bumped on every write, in the same transaction |
| `claimed_by` | participant id, null when unclaimed |
| `claim_token` | opaque, rotates per claim |
| `lease_expires_at` | unix ms |
| `claim_count` | attempts, for detecting poison items |
| `created_at`, `updated_at` | unix ms |

**Others:** `participants`, `api_tokens`, `comments`, `history`, `blocks`,
`idempotency_keys`, `events`.

### Status and blocking are separate axes

```
ready ──► doing ──► review ──► done
  ▲        ▲          │         │
  └────────┴──────────┘         │
  └───────── reopen ────────────┘
```

`is_blocked` is **derived**, never stored as a status: an item is blocked if it
has an unresolved row in `blocks` (either a dependency on an open item, or a
manual block with a reason and an author). Blocking hides an item from
`claim-next`; it does not change its status. There is no `previous_status`,
because nothing overwrites status in the first place. `done` is reopenable —
work comes back, and a terminal state that lies is worse than no state.

---

## 4. Claim leases

The core mechanic. An agent claims exclusively, holds a lease, renews while
working, and the work returns to the queue if the agent dies.

```
POST /api/items/claim-next   { lease_seconds }  → 200 { item, claim_token } | 204
POST /api/items/:id/renew    { claim_token, lease_seconds }
POST /api/items/:id/release  { claim_token, reason }
POST /api/items/:id/complete { claim_token }
```

**Selection** is deterministic and runs in one transaction — `bun:sqlite` is
synchronous, so two agents cannot select the same row:

```sql
SELECT id FROM work_items
WHERE status = 'ready' AND claimed_by IS NULL
  AND id NOT IN (SELECT item_id FROM blocks WHERE resolved_at IS NULL)
ORDER BY priority DESC, created_at ASC
LIMIT 1;
-- then UPDATE ... SET claimed_by, claim_token, lease_expires_at, status='doing'
```

**Ownership:** any mutation on a claimed item requires the matching
`claim_token`, or it fails `409 not_claim_owner`. Comments are exempt — humans
must be able to talk on an item an agent holds.

**Recovery:** a sweep (`Bun.cron`, every 30s) finds `lease_expires_at < now`,
returns the item to `ready`, clears the claim, increments nothing, and writes a
`lease_expired` history entry. An admin-scoped `POST /api/items/:id/force-release`
does the same by hand.

**Tests (Phase 1, non-negotiable):** two concurrent processes racing
`claim-next` over 100 items get disjoint sets summing to 100; a killed process's
item returns to `ready` after expiry; a renew after expiry fails; a renew with a
stale token fails; completing with a rotated token fails.

---

## 5. Idempotency and concurrency

Agents retry after ambiguous failures. Without this, retries silently duplicate.

**Every mutation accepts `Idempotency-Key`.** The server stores
`(key, participant_id) → (request_hash, status, response_body)`. A replay with a
matching hash returns the stored response verbatim; a replay with a different
body returns `409 idempotency_key_reuse`. Keys expire after 24h.

**Every update requires a revision.** `If-Match: <revision>` on PATCH. Missing →
`428 revision_required`. Mismatch → `409 stale_revision`, and the response
carries the current revision and current item so the caller can merge rather
than guess. Never last-write-wins.

**Error envelope** — one shape, machine-readable codes:

```json
{ "error": { "code": "stale_revision", "message": "…", "details": { "current_revision": 7 } } }
```

Codes: `stale_revision`, `revision_required`, `idempotency_key_reuse`,
`not_claim_owner`, `lease_expired`, `invalid_transition`, `item_blocked`,
`unauthorized`, `forbidden`, `not_found`, `validation_failed`.

---

## 6. Markdown safety

**Raw HTML is disabled entirely.** Comment bodies are written by agents relaying
untrusted text; a hand-written tag denylist will eventually lose to a browser
parsing quirk, which is exactly what OWASP warns against.

1. HTML-escape `<` and `&` in the source *before* `Bun.markdown` sees it. This
   removes inline HTML as a category — not a filter, an absence. All ordinary
   markdown still works.
2. Post-render, reject any `href`/`src` whose scheme isn't `http`, `https`,
   `mailto`, or relative.
3. Strict CSP: no `unsafe-inline`, no `unsafe-eval`.
4. Test corpus of known payloads asserted inert.

If rich HTML is ever genuinely required, the answer is bundling a maintained
sanitizer, not writing one.

---

## 7. Identity

**Tokens are bound to participants.** `api_tokens`: `participant_id`, `name`,
`hash` (`Bun.password`), `scopes`, `expires_at`, `revoked_at`, `last_used_at`.

The actor for every write is derived from the token. `actor`, `author`, and
`--agent` are **never** accepted from the client. An audit trail that any token
can impersonate into is not an audit trail.

Scopes: `read`, `write`, `admin`. Admin covers token issuance, force-release,
migrate, and backup. Token operations write history like anything else.

**MCP uses the official SDK** (`@modelcontextprotocol/server`, stdio transport).
`bun build --compile` bundles npm packages into the executable, so a dependency
here costs the user nothing at deploy time — the "single binary" promise is about
deployment, not about the dependency graph. Hand-rolling JSON-RPC framing to
avoid one bundled package would trade protocol negotiation, validation, and spec
conformance for nothing.

---

## 8. Phases

### Phase 0 — Falsification spike (1–2 days)

One throwaway spike proving the load-bearing assumptions before any structure
exists. Not a scaffold — a disposable answer to "does this work at all?"

- `bun build --compile` produces a binary that serves HTTP and opens a
  **persistent, on-disk** SQLite file that survives restart
- The official MCP SDK runs inside that compiled binary over stdio
- A **real MCP client** (Claude Code or Codex) connects and calls one tool that
  hits the running server

**Stop condition:** if the compiled binary can't host the MCP SDK, or a real
client can't call it, the architecture changes before anything is built on it.

### Phase 1 — The vertical slice

The whole point. One workflow, end to end, through all three interfaces:

```
create → list → show → claim → renew → comment → complete
                          └──► release
```

- `packages/core`: schema, migrations, the queries above, lease logic
- `packages/client`: Zod schemas, typed SDK, idempotency + `If-Match` handling
- `apps/server`: those endpoints, token auth, error envelope
- `apps/cli`: the same verbs
- `apps/mcp`: the same verbs as MCP tools via the SDK
- Tests: contention, crash recovery, lease expiry, retry-safety, stale writes

**Exit:** a real agent runs the loop against the **compiled binary**, not `bun run`.

### Phase 2 — Dogfood gate ⛔

**Use it. 50+ real work items, 2 agents, one week.** No new features during this
window; only bugs found by using it.

**Stop condition — answer honestly:** do the agents and I actually prefer this to
a markdown task file? If no, either fix what's missing or stop building. The
previous plan had no such gate, which is how a tool nobody wanted could have
reached Phase 7.

### Phase 3 — Minimal web board

Only if Phase 2 passes. Four columns, item detail, comments, blocked indicator.
Stale-write handling surfaced in the UI (a 409 shows what changed, never a silent
revert). SSE with **resumable event IDs** — `Last-Event-ID` replay from the
`events` table, because a board that silently misses updates is worse than
polling. Stock shadcn via `packages/ui`; no custom theme yet.

### Phase 4 — Operational hardening

Identity-bound token management, backup **and a tested restore**, automatic
pre-migration snapshot, migration-from-previous-binary-version test, service
lifecycle for Linux and macOS, structured logs.

### Phase 5 — Earned extras

In rough order: design system governance (themes, playground, the three visual
lint rules), mentions and Hermes dispatch, hierarchy, cross-compilation, extra
platforms.

---

## 9. Admin operations vs. the single writer

The single-writer invariant only holds if nothing else opens the file. So:

| Operation | How |
|-----------|-----|
| `migrate` | Runs at server startup, automatically, after a pre-migration snapshot |
| `backup` | `POST /api/admin/backup` — the running server does `VACUUM INTO` |
| `token create` | `POST /api/admin/tokens` (bootstrap token printed on first run) |
| Offline variants | `workboard <cmd> --offline` refuses to run if the server holds the lock |

`VACUUM INTO` gives a consistent snapshot of a live database, but an interrupted
run can leave an incomplete file. So: write to `backups/.tmp-<ts>`, `fsync`,
verify with `PRAGMA integrity_check` on the copy, then atomically rename. A
backup that has never been restored is a hope, not a backup — Phase 4 includes a
restore test.

---

## 10. Testing

| Layer | Approach |
|-------|----------|
| `core` | **Disk-backed** SQLite in a temp dir, WAL on — exercises journaling, file permissions, restart |
| Contention | Real concurrent **processes**, not async loops |
| Recovery | `SIGKILL` a claimant mid-work; assert the item returns |
| Retry-safety | Every mutation replayed with the same `Idempotency-Key` |
| Migration | Build previous version's DB, run current binary, assert upgrade |
| Restore | Backup → restore into a fresh dir → assert row-level equality |
| Binary | The compiled artifact drives the full Phase 1 loop |
| Web (Phase 3) | Playwright on the real binary. A playground is a showcase, not a test |

In-memory SQLite is used only for fast unit tests of pure logic. Anything
touching durability uses a real file.

---

## 11. Success criteria

Product, not implementation:

- [ ] Setup to first claimed item in **under five minutes**
- [ ] Two agents never hold the same item
- [ ] A crashed agent's work returns to the queue automatically
- [ ] Retries after network failures create no duplicates
- [ ] Stale writes never silently overwrite
- [ ] A backup restores and matches
- [ ] **After one week of real use, agents and I prefer it to a markdown file**

The last one is the only one that decides whether the rest mattered.

---

## 12. Open questions

1. **Lease duration default.** 5 min with renew-every-2? Agent tasks vary from
   seconds to an hour. Too short thrashes; too long strands.
2. **Poison items.** After N failed claims, auto-park an item for human review?
3. **Comments during another agent's claim** — allowed above, but should the
   claimant be notified, and how, with mentions deferred?
4. **`events` retention.** Resumable SSE needs history; how long before pruning?
5. **Bootstrap token UX.** Printed once on first run, or a `--no-auth` loopback
   dev mode that's refused when `--host` is public?
