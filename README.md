# Agent Workboard

A local-first work queue for one repository, coordinating 2–10 coding agents and
one human — with recoverable exclusive claims and durable progress.

> **Status: not built yet.** This describes the target. `PLAN.md` is the
> authoritative build order. Nothing in this file exists until its phase ships.

## The problem

Agents coordinating through a shared markdown task file duplicate work, clobber
each other's edits, and strand tasks when one crashes mid-run. This is that file,
with a lease.

## Shape

One binary owns one SQLite database. Everything else is a client.

```
   browser  ───►┐
                │  workboard serve
   CLI      ───►┤    /api/*  REST + SSE
                │    /web/*  board UI
   agent    ───►┘    bun:sqlite ──► wb_data/
   (MCP stdio)
```

```bash
./workboard serve --dir ./wb_data --port 8765
```

`scp` the binary, run it. Upgrading is replacing the binary.

## Core mechanic: the claim lease

An agent claims a work item **exclusively**, gets a `claim_token`, and holds a
lease while it works.

```bash
workboard claim --lease 300      # → item + claim_token, status: doing
workboard renew  12 --lease 300  # keep it while still working
workboard done   12              # requires the token
workboard release 12 --reason "needs human input"
```

If the agent dies, the lease expires and the item returns to the queue on its
own. That recovery is the reason this exists rather than a text file.

## Guarantees

| Property | Mechanism |
|----------|-----------|
| Two agents never hold one item | Selection + claim in a single SQLite transaction |
| Crashed work is recoverable | Lease expiry sweep returns items to `ready` |
| Retries don't duplicate | `Idempotency-Key` on every mutation |
| Stale writes never clobber | `If-Match: <revision>`, `409 stale_revision` |
| The audit trail can't be faked | Actor derived from the token, never from the request |
| Comment markdown can't XSS | Raw HTML disabled at the source, plus strict CSP |

## Status

```
ready ──► doing ──► review ──► done ──► (reopen)
```

Blocking is a **separate axis**, not a status: an item is blocked while it has an
unresolved dependency or a manual block. Blocked items are skipped by
`claim-next` but keep their status.

## Interfaces

All three speak to the same REST API, so behavior can't drift between them.

- **MCP** — `workboard mcp`, official SDK over stdio. How agents use it.
- **CLI** — `workboard ls / show / claim / renew / release / comment / done`.
- **Web** — a four-column board at `/web`, live over SSE. *(Phase 3)*

## Stack

Bun 1.4.0, TypeScript strict, `bun:sqlite` (WAL), Zod, official MCP SDK,
React + shadcn/ui for the board. `bun build --compile` bundles all of it into one
executable — dependencies are a build-time concern, not something users install.

## Not doing (yet)

Deferred until real use proves the core is worth extending: themes and component
playground, @mentions and notifications, nested hierarchies, multi-project
support, Windows services, per-user permissions, search, attachments.

See `PLAN.md` — including the dogfood gate that decides whether any of it
gets built.
