# Verification Matrix

Executed 2026-09-03 against the Task 1–18 implementation (HEAD `e8a81e5`).
Every required check from the plan ran to completion; nothing was skipped.

## Commands

| Command | Exit code | Result |
| --- | --- | --- |
| `bun run typecheck` | 0 | clean (strict + exactOptionalPropertyTypes) |
| `bun test` | 0 | 214 tests, 0 fail, 18 files |
| `bun run build` | 0 | 292 modules bundled, `dist/workboard` ELF executable |
| `bun run test:e2e` | 0 | compiled-binary flow passes end to end |

## Required additional checks

| Check | Exit code | Result |
| --- | --- | --- |
| Fresh-database migration (`workboard --dir <empty> init`) | 0 | schema v1 applied from nothing |
| Upgrade-fixture migration when migration 002 exists | n/a | 002 does not exist yet; `migrate()` unit tests cover pending-application and future-version rejection |
| Real MCP SDK client integration (HTTP + stdio contract tests) | 0 | official `@modelcontextprotocol/sdk` 1.30.0 clients negotiate revision 2025-11-25 over both transports |
| REST/MCP/CLI parity, one item lifecycle | 0 | 15/15 checks: REST-created item visible via MCP `list_work` and CLI `view`; comments from both transports; history ≥3 entries; `done` sets `closedAt` |
| Markdown XSS corpus (8 payloads, real browser) | 0 | 7/7 checks: no dialogs, no `script`/`iframe`/`img`/`svg` elements created, only `https:` links rendered, payload text preserved verbatim |
| Two-client actor attribution | 0 | REST create → `rest-client`, CLI create → `cli-client` (distinct participants) |
| SIGTERM graceful shutdown | 0 | compiled binary exits 0 on SIGTERM (`server.stop(true)`, db closed) |
| No plaintext tokens in logs/database snapshots | 0 | `wb_…` material absent from `workboard.sqlite`, `-wal`, and serve logs (only SHA-256 digests stored) |

## Real-browser verification per UI task (Playwright + Chromium)

| View | Checks | Verdict |
| --- | --- | --- |
| Board (Task 13): login, bad-token rejection, columns, quick-add, keyboard move, drag & drop, persistence, detail routing, sign out | 13/13 | PASS |
| List (Task 14): pagination 25+5, status/assignee/label filters, search, bulk assign/unassign, routing | 13/13 | PASS |
| Detail (Task 15): markdown-safe body, mention autocomplete, comment post, history, delete | 18/18 | PASS |
| Live updates (Task 16): external create/move/comment/delete appear without user action | 7/7 | PASS |
| XSS corpus (Task 19) | 7/7 | PASS |

## Notes

- Backup uses `VACUUM INTO` (consistent against the live WAL database); restore
  validates header, `integrity_check`, required tables, and schema version, and
  refuses to overwrite without `--force` (Task 17 tests: 5/5).
- Single-binary acceptance ran from a clean directory using only
  `dist/workboard`: `--version`, `participant add --dir …`, `token create …`,
  `serve --dir … --port …`, health, web shell, REST create, MCP `tools/list`.
