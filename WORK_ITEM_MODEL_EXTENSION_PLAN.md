# Work-Item Model Extension Plan

## Confirmed decisions

- Add four work-item types: `feature`, `user_story`, `bug`, and `task` (displayed as Feature, User Story, Bug, and Task).
- Hierarchy remains flexible: any type may parent any other type.
- A Task must always have a parent.
- Support Parent/Child, Related, Predecessor/Successor, and Duplicate/Duplicate Of relationships.
- The backlog shows `todo`, `doing`, and `blocked` items and excludes `done`.
- Backlog order is scoped to siblings. Moving across levels reparents the item.
- Backlog parents remain collapsed by default.
- Existing work-item data may be deleted because this model has not been deployed. Participants, labels, API tokens, and authentication settings are preserved.
- Implementation and verification must not access or mutate `workboard-data/`; tests use disposable data directories.

## Domain rules

1. Every item has a valid work-item type.
2. Top-level quick-add defaults to User Story; child quick-add defaults to Task.
3. A Task cannot be created without a parent.
4. Changing an item to Task requires an existing parent or a parent supplied atomically in the same update.
5. A Task cannot be detached from its parent.
6. Parent/child links remain single-parent, self-link-free, and cycle-free.
7. Deleting an item with children is rejected until its children are reparented or deleted.
8. Non-hierarchical relationships reject self-links and duplicates.
9. Related links are symmetric and stored once.
10. Dependencies are stored predecessor to successor and cannot form cycles.
11. Duplicate links are stored duplicate to original; an item cannot have conflicting originals.
12. Relationship, type, parent, and backlog-order changes are transactional, audited, and publish SSE events only after commit.

## Phase 1 — Schema and domain

Add migration `src/db/migrations/003_work_item_model.sql` and register it in `src/db/schema.ts`.

The migration will intentionally delete existing item-domain rows while preserving participants, labels, and API tokens. It will add `items.work_item_type`, `items.backlog_position`, type/order indexes, Task-parent and safe-parent-deletion triggers, and an `item_links` table for Related, Dependency, and Duplicate links.

Extend `src/domain/types.ts` with `WorkItemType`, stored relationship kinds, and public relative relationship names. Wire/storage values use lowercase snake case; the UI uses human-readable labels.

## Phase 2 — Repositories and service

Extend the item repository to read/write/filter type and backlog position, list the complete unfinished backlog without the generic 100-item limitation, append new items to sibling order, and atomically reorder/reparent by `{ parentId, beforeId }`.

Add an item-links repository that normalizes symmetric Related links, maps directional relationships relative to the requested item, prevents dependency cycles, and batch-loads related item summaries.

Extend DTOs and `WorkboardService` so item data includes `type` and `backlogPosition`. Rename detail `subtasks` to `children`. Detail responses include parent, children, related items, predecessors, successors, duplicates, and duplicate-of target. Add service operations for relationship mutation and backlog movement.

Backend support must be complete before frontend hierarchy, relationship, or ordering work.

## Phase 3 — REST, MCP, and CLI parity

REST:

- Create/update accepts `type`.
- `GET /api/items?type=bug`.
- `GET /api/backlog` returns all unfinished items in backlog order.
- Add/remove relationship endpoints.
- Add a reorder endpoint accepting `{ parentId, beforeId }`.

MCP:

- Extend `create_work`, `update_work`, `list_work`, and `get_work`.
- Add `add_work_relationship`, `remove_work_relationship`, and `reorder_work`.

CLI:

- Add `--type` and parent support to add/update/list.
- Display types and relationships.
- Add relationship and reorder commands.
- Preserve structured JSON parity.

All new API/MCP routes remain authenticated. Logging must never include credentials, request bodies, item content, or query strings.

## Phase 4 — Web model and presentation

Update strict response parsers and types for the new fields. Add consistent work-item type badges/icons to Board, List, Backlog, Detail, and relationship rows. Add type filtering and editing. Authentication failures continue to terminate board work and defer to the shell.

Replace the parent/sub-task-only Detail section with Parent, Children, Related, Predecessors, Successors, Duplicates, and Duplicate Of groups. Support bounded item search or item ID when linking. Child quick-add defaults to Task and supplies the current item as parent.

## Phase 5 — Ordered backlog

Refactor Backlog to consume `GET /api/backlog` and render all unfinished items. Preserve the nested, collapsed-by-default tree. Sort siblings by `backlogPosition`, then ID. Add type and status presentation and a type-aware quick-add control.

Add drag handles and keyboard-accessible ordering actions. Reorder siblings, permit cross-level reparenting, reject moving a Task to root, announce moves through `aria-live`, and roll back failed optimistic updates. SSE remains owned by `AppShell` and reconciles concurrent server changes.

## Phase 6 — Tests and verification

Use only disposable data outside the repository.

Cover migration behavior, all four types, Task-parent enforcement, flexible hierarchy, hierarchy/dependency cycles, relationship symmetry/direction/uniqueness, audit/SSE atomicity, sibling and cross-parent ordering, deterministic ordering after mutations, and a backlog larger than 100 items.

Verify REST/MCP/CLI parity, authentication, secret-safe logging, strict browser parsing, Detail mutation reconciliation, relationship UI, pointer and keyboard backlog movement, loading/error/retry states, and terminal authentication behavior.

Run `bun run build:web`, `bun run typecheck`, focused tests, full `bun test`, `bun run build`, packaged-binary tests, UI/UX review, and mandatory real-browser web-tester verification. Completion requires `VERDICT: PASS`.

## Implementation order

1. Schema and domain types.
2. Repositories and service contracts.
3. REST, MCP, and CLI transports.
4. Shared web data/types.
5. Detail relationship UI.
6. Ordered backlog UI.
7. Automated, packaging, design, and real-browser verification.
