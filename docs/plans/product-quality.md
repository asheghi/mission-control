# Workboard product quality

## Evidence

TalaTala's first week of Workboard use showed many nested items, agent assignments, and agent comments. Claude mostly accessed Workboard through shell commands rather than native Workboard MCP tools. These are observed workflow signals, not proof of a general-purpose product requirement. Read-only observations were made against its separate project board; never use it as a development fixture.

## Delivered in this iteration

- My work: assigned and mentioned items, status URL filter, paginated results, live refresh, and explicit failure/empty states.
- Long item discussions: show recent comments first and progressively reveal older history without changing chronological order.
- Backlog: clearer item hierarchy, compact metadata and responsive row presentation.
- Board on narrow screens: visible status switcher replaces clipped horizontal columns; moving an item changes the visible lane and restores keyboard focus.
- Application attachment lifecycle: separate upload, read, deletion, and maintenance responsibilities behind the stable `WorkboardService` API. Shared streamed-upload type lives outside HTTP transport code.
- Detail quick-field reconciliation extracted into a pure, tested module; async mutation scheduling stays in the view hook.
- Optional seeded visual baseline: `WORKBOARD_VISUAL_REVIEW_DIR=.tmp/visual-review bun run test:e2e:web` captures all four main views at desktop/mobile widths and in light/dark themes. The output is gitignored.

## Next quality gates

1. Continue the visual review against the repeatable seeded baseline. The first review found the mobile Board hid adjacent columns without an affordance; the status switcher fixes that. Review detail's sparse states, dark-theme contrast, long text, and touch targets with more realistic content before declaring design complete.
2. Break up the remaining large detail state controller and the item/relationship orchestration in `src/app/workboard.ts` by responsibility. Retain the service facade, one transaction owner for each write, transport-independent contracts, and existing concurrency semantics. Refactor in tested slices rather than splitting by arbitrary line limits.
3. Validate My work with TalaTala's actual workflow using read-only observation. Assess whether predecessor context and handoff summaries reduce missed or duplicated work before proposing new server contracts; do not silently treat links as enforced blockers.
4. Improve the agent's native Workboard MCP setup in the consuming environment only after confirming what Claude clients support. Avoid using production credentials or board data in development tests.

## Verification standard

Every slice: `bun run typecheck`, relevant tests, compiled `bun run build`, `bun test`, and `bun run test:e2e:web` on disposable data. The shipped executable must remain offline and self-contained. A green browser flow does not substitute for a design review.
