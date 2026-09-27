// The development seed dataset.
//
// This is data, not logic: a fixed, hand-written board that exercises every
// shape the product has to render. It is deliberately deterministic — no
// randomness, no dates, no environment reads — so a seeded board is identical
// on every machine, a screenshot taken today matches one taken next week, and a
// test can assert on a specific item by key.
//
// The dataset is about *this* product on purpose: a developer running
// `workboard seed` should recognise the board they are working on, and the
// seeded content doubles as a fixture for the web UI's markdown, mention,
// hierarchy, relationship, and long-title rendering.
//
// Invariants the seeder relies on (it goes through WorkboardService, so they are
// enforced rather than assumed):
//   * a `task` always has a parent, so every task below is nested;
//   * any type may parent any other type, so stories and bugs are nested too;
//   * labels must exist before an item can use them;
//   * participants are addressed by name, and every name is in SEED_PARTICIPANTS.
import type { ItemRelationshipName, Priority, WorkItemType, WorkStatus } from "../domain/types";

export interface SeedComment {
  /** Participant name; must exist in SEED_PARTICIPANTS. */
  readonly author: string;
  readonly body: string;
}

export interface SeedItem {
  /** Stable handle used by relationships; never shown to a user. */
  readonly key: string;
  readonly title: string;
  readonly body?: string;
  /** Defaults to `task` for a nested item and `user_story` at the top level. */
  readonly type?: WorkItemType;
  readonly status?: WorkStatus;
  readonly priority?: Priority;
  /** Participant name; omit for an unassigned item. */
  readonly assignee?: string;
  /** Participant credited with creating the item; defaults to the first human. */
  readonly creator?: string;
  readonly labels?: readonly string[];
  readonly comments?: readonly SeedComment[];
  readonly children?: readonly SeedItem[];
}

export interface SeedRelationship {
  /** `from` sees `to` as `name` (a non-hierarchical link). */
  readonly from: string;
  readonly name: Extract<ItemRelationshipName, "related" | "predecessor" | "successor" | "duplicate" | "duplicate_of">;
  readonly to: string;
}

export interface SeedParticipant {
  readonly name: string;
  readonly kind: "human" | "agent";
  readonly avatarColor: string;
}

export interface SeedLabel {
  readonly name: string;
  readonly color: string;
}

export interface SeedDataset {
  readonly participants: readonly SeedParticipant[];
  readonly labels: readonly SeedLabel[];
  readonly items: readonly SeedItem[];
  readonly relationships: readonly SeedRelationship[];
}

export const SEED_PARTICIPANTS: readonly SeedParticipant[] = [
  { name: "ada", kind: "human", avatarColor: "#3B82F6" },
  { name: "ren", kind: "human", avatarColor: "#EC4899" },
  { name: "codex", kind: "agent", avatarColor: "#10B981" },
  { name: "claude", kind: "agent", avatarColor: "#F59E0B" },
  { name: "dsh", kind: "agent", avatarColor: "#8B5CF6" },
];

export const SEED_LABELS: readonly SeedLabel[] = [
  { name: "ui", color: "#3B82F6" },
  { name: "api", color: "#10B981" },
  { name: "infra", color: "#F59E0B" },
  { name: "docs", color: "#8B5CF6" },
  { name: "bug", color: "#EF4444" },
  { name: "perf", color: "#EC4899" },
  { name: "security", color: "#0EA5E9" },
  { name: "tech-debt", color: "#6B7280" },
];

export const SEED_RELATIONSHIPS: readonly SeedRelationship[] = [
  { from: "order-bug", name: "duplicate_of", to: "backlog-view" },
  { from: "mention-bug", name: "related", to: "mcp-tools" },
  { from: "heartbeat-feature", name: "related", to: "live-updates" },
  { from: "tz-bug", name: "predecessor", to: "export-markdown" },
  { from: "palette-story", name: "related", to: "list-view" },
];

export const SEED_ITEMS: readonly SeedItem[] = [
  {
    key: "backlog-view",
    title: "Backlog view with nested sub-tasks",
    type: "feature",
    status: "doing",
    priority: 1,
    assignee: "ren",
    labels: ["ui", "api"],
    body: [
      "A single ordered list of everything unfinished, with children nested under",
      "their parent so a feature and its sub-tasks read as one block.",
      "",
      "## Done when",
      "",
      "- rows are ordered by `(parent, backlog_position, id)`",
      "- a collapsed parent hides its children but keeps them loaded",
      "- a row can be moved with the pointer *or* the keyboard",
      "- `GET /api/backlog` stays unpaginated and uncapped",
    ].join("\n"),
    comments: [
      { author: "ren", body: "Expanded rows are the part I keep re-learning. @codex can you take the nesting?" },
      { author: "codex", body: "Nesting is in. The keyboard move buttons are the last piece on my list." },
    ],
    children: [
      {
        key: "backlog-drag-handle",
        title: "Add a labelled drag handle to every row",
        type: "task",
        status: "done",
        assignee: "codex",
      },
      {
        key: "backlog-task-guard",
        title: "Refuse to drop a task at the top level",
        type: "task",
        status: "done",
        assignee: "codex",
      },
      {
        key: "backlog-keyboard",
        title: "Reorder a row without a pointer",
        type: "user_story",
        status: "doing",
        assignee: "codex",
        labels: ["ui"],
        body: "As a keyboard user I can move any backlog row, so ordering is never pointer-only.",
        children: [
          {
            key: "backlog-move-buttons",
            title: "Render all four move buttons on every row",
            type: "task",
            status: "done",
            assignee: "codex",
          },
          {
            key: "backlog-refusal-region",
            title: "Announce a refused move in the live region",
            type: "task",
            status: "todo",
            assignee: "codex",
          },
        ],
      },
      {
        key: "backlog-collapse-bug",
        title: "Children disappear when a parent is collapsed",
        type: "bug",
        status: "blocked",
        priority: 0,
        assignee: "ada",
        labels: ["bug", "ui"],
        body: "Collapsing a parent drops the children's backlog positions, so re-expanding\nshows them in the wrong order.\n\nBlocked on @codex to confirm the ordering rule first.",
      },
    ],
  },
  {
    key: "board-view",
    title: "Board view with four status columns",
    type: "feature",
    status: "done",
    assignee: "ada",
    labels: ["ui"],
    children: [
      { key: "board-quick-add", title: "Quick add inside every column", type: "task", status: "done", assignee: "ada" },
      { key: "board-focus", title: "Keep focus on the control that moved a card", type: "task", status: "done", assignee: "ada" },
    ],
  },
  {
    key: "live-updates",
    title: "Live updates over Server-Sent Events",
    type: "feature",
    status: "doing",
    priority: 1,
    assignee: "dsh",
    labels: ["api", "infra"],
    body: "One event stream per signed-in session. `EventSource` cannot carry the\nbearer header, so the client reads the stream through `fetch`.",
    children: [
      {
        key: "reconnect-backoff",
        title: "Reconnect with capped exponential backoff",
        type: "user_story",
        status: "done",
        assignee: "dsh",
        comments: [{ author: "dsh", body: "1s base, 30s cap, and one notification per transition." }],
      },
      {
        key: "reconnect-storm",
        title: "Every tab reconnects at once after a server restart",
        type: "bug",
        status: "todo",
        priority: 1,
        assignee: "claude",
        labels: ["bug", "infra"],
        body: "Ten open tabs produce ten reconnects in the same second. Needs jitter.",
      },
      { key: "event-heartbeat", title: "Send a heartbeat comment frame every 15 seconds", type: "task", status: "done", assignee: "dsh" },
      { key: "typing-defer", title: "Defer a refresh while the user is typing", type: "task", status: "doing", assignee: "codex" },
    ],
  },
  {
    key: "mcp-tools",
    title: "MCP tools for agents",
    type: "feature",
    status: "doing",
    priority: 1,
    assignee: "claude",
    labels: ["api", "docs"],
    body: "Nine tools, one service layer underneath. Agents and humans are the same\nparticipant row, so assignment and @mentions work identically.",
    children: [
      { key: "mcp-bounds", title: "Cap title and body at the transport bound", type: "task", status: "done", assignee: "claude" },
      { key: "mcp-my-work", title: "my_work returns assigned and mentioned items", type: "user_story", status: "done", assignee: "claude" },
      {
        key: "mcp-docs",
        title: "Document all nine tools in the manual",
        type: "task",
        status: "todo",
        assignee: "ren",
        labels: ["docs"],
      },
    ],
  },
  {
    key: "item-detail",
    title: "Item detail with inline editing",
    type: "feature",
    status: "done",
    assignee: "ada",
    labels: ["ui"],
    children: [
      { key: "detail-diff", title: "Diff the description history", type: "task", status: "done", assignee: "ada" },
      { key: "detail-mentions", title: "Mention autocomplete in the comment composer", type: "task", status: "done", assignee: "ada" },
    ],
  },
  {
    key: "list-view",
    title: "All-work list with filters and bulk actions",
    type: "feature",
    status: "doing",
    priority: 2,
    assignee: "ren",
    labels: ["ui"],
    children: [
      { key: "list-url-filters", title: "Restore filters from the URL hash", type: "task", status: "done", assignee: "ren" },
      { key: "list-bulk-assign", title: "Bulk assign from the selection bar", type: "task", status: "todo", assignee: "ren" },
      {
        key: "list-cursor-bug",
        title: "The pagination cursor repeats the last page",
        type: "bug",
        status: "blocked",
        priority: 1,
        assignee: "ada",
        labels: ["bug"],
        body: "Loading a page twice returns the same ids, so the cursor is derived from\nsomething that does not change between requests.",
      },
    ],
  },
  {
    key: "auth-tokens",
    title: "Token authentication for humans and agents",
    type: "feature",
    status: "done",
    priority: 1,
    assignee: "dsh",
    labels: ["security", "api"],
    children: [
      { key: "token-revoke", title: "Revoke a token by id from the CLI", type: "task", status: "done", assignee: "dsh" },
      { key: "token-fragment", title: "Sign in with a fragment token link", type: "user_story", status: "done", assignee: "dsh" },
    ],
  },
  {
    key: "backup-restore",
    title: "Backup and restore commands",
    type: "feature",
    status: "todo",
    priority: 3,
    assignee: "dsh",
    labels: ["infra", "docs"],
    children: [
      { key: "backup-snapshot", title: "Write a consistent snapshot", type: "task", status: "todo", assignee: "dsh" },
      { key: "backup-live-serve", title: "Refuse to restore over a live serve", type: "task", status: "todo", assignee: "dsh" },
    ],
  },

  // --- Top-level work that is not nested under a feature ----------------------
  {
    key: "order-bug",
    title: "Backlog order jumps after a reorder",
    type: "bug",
    status: "todo",
    priority: 1,
    assignee: "codex",
    labels: ["bug", "ui"],
    body: "Moving a row to the top leaves a gap in `backlog_position`, and the next\ninsert lands between two items that used to be adjacent.",
  },
  {
    key: "mention-bug",
    title: "A comment mention does not notify the assignee",
    type: "bug",
    status: "todo",
    priority: 2,
    assignee: "claude",
    labels: ["bug"],
  },
  {
    key: "label-filter-story",
    title: "Filter the backlog by label",
    type: "user_story",
    status: "todo",
    priority: 3,
    assignee: "ren",
    labels: ["ui"],
  },
  {
    key: "palette-story",
    title: "Keyboard shortcut palette",
    type: "user_story",
    status: "todo",
    priority: 3,
    assignee: "ada",
    labels: ["ui"],
  },
  {
    key: "pwa-shell",
    title: "Offline-friendly PWA shell",
    type: "feature",
    status: "todo",
    priority: 3,
    assignee: "ada",
    labels: ["infra"],
    children: [
      { key: "pwa-service-worker", title: "Cache the bundle with a service worker", type: "task", status: "todo", assignee: "ada" },
    ],
  },
  {
    key: "tz-bug",
    title: "Closed items render their time in UTC",
    type: "bug",
    status: "done",
    priority: 2,
    assignee: "ren",
    labels: ["bug", "ui"],
  },
  {
    key: "export-markdown",
    title: "Export the backlog as Markdown",
    type: "user_story",
    status: "done",
    priority: 3,
    assignee: "ren",
    labels: ["docs"],
  },
  {
    key: "overflow-bug",
    title: "Long titles overflow the board card",
    type: "bug",
    status: "done",
    priority: 2,
    assignee: "ada",
    labels: ["bug", "ui"],
  },
  {
    key: "heartbeat-feature",
    title: "Agent heartbeat visibility",
    type: "feature",
    status: "todo",
    priority: 2,
    assignee: "dsh",
    labels: ["api"],
    children: [
      { key: "heartbeat-story", title: "Show when an agent last ran my_work", type: "user_story", status: "todo", assignee: "dsh" },
      { key: "heartbeat-history", title: "Record the tool call in item history", type: "task", status: "todo", assignee: "dsh" },
    ],
  },
  {
    key: "stdio-bug",
    title: "The stdio MCP adapter writes chatter to stdout",
    type: "bug",
    status: "done",
    priority: 0,
    assignee: "claude",
    labels: ["bug", "api"],
  },
  {
    key: "epic-story",
    title: "Group the backlog by epic",
    type: "user_story",
    status: "todo",
    priority: 3,
    assignee: "ada",
    labels: ["ui"],
  },
  {
    key: "doctor-bug",
    title: "doctor reports healthy while the port is taken",
    type: "bug",
    status: "blocked",
    priority: 2,
    assignee: "dsh",
    labels: ["bug", "infra"],
  },

  // --- Routine chores ---------------------------------------------------------
  //
  // Volume on purpose: a board with 60+ items is what makes the list's
  // pagination, the backlog's row count, and a screenshot of a busy board look
  // like the real thing. These are children because a task always has a parent.
  {
    key: "chores",
    title: "Routine maintenance chores",
    type: "feature",
    status: "todo",
    priority: 3,
    assignee: "ren",
    labels: ["tech-debt"],
    body: "The small recurring work that never deserves its own planning session.",
    children: [
      { key: "chore-1", title: "Prune unused feature flags", status: "done", assignee: "codex", labels: ["tech-debt"] },
      { key: "chore-2", title: "Re-run the contract suite against the released SDK", status: "done", assignee: "claude", labels: ["tech-debt"] },
      { key: "chore-3", title: "Refresh the screenshot in the README", status: "done", assignee: "ren", labels: ["docs", "tech-debt"] },
      { key: "chore-4", title: "Delete dead CSS rules left by the legacy frontend", status: "done", assignee: "ada", labels: ["ui", "tech-debt"] },
      { key: "chore-5", title: "Check the WAL file growth on a long-running board", status: "todo", assignee: "dsh", labels: ["infra", "tech-debt"] },
      { key: "chore-6", title: "Audit the request log for oversized fields", status: "todo", assignee: "dsh", labels: ["tech-debt"] },
      { key: "chore-7", title: "Replace the hard-coded status order in two places", status: "todo", assignee: "codex", labels: ["tech-debt"] },
      { key: "chore-8", title: "Add a smoke test for the login redirect", status: "todo", assignee: "codex", labels: ["tech-debt"] },
      { key: "chore-9", title: "Verify keyboard focus order in the detail panels", status: "todo", assignee: "ada", labels: ["ui", "tech-debt"] },
      { key: "chore-10", title: "Trim the seed dataset comments", status: "todo", assignee: "ren", labels: ["tech-debt"] },
      { key: "chore-11", title: "Check the label palette contrast in dark mode", status: "todo", assignee: "ada", labels: ["ui", "tech-debt"] },
      { key: "chore-12", title: "Document the data directory layout for operators", status: "todo", assignee: "ren", labels: ["docs", "tech-debt"] },
      { key: "chore-13", title: "Measure cold start on the compiled binary", status: "todo", assignee: "claude", labels: ["perf", "tech-debt"] },
      { key: "chore-14", title: "Cache the participant roster in the list view", status: "todo", assignee: "codex", labels: ["perf", "tech-debt"] },
      { key: "chore-15", title: "Review error copy for plain language", status: "todo", assignee: "ada", labels: ["ui", "tech-debt"] },
      { key: "chore-16", title: "Add a 404 route that keeps the shell", status: "todo", assignee: "ada", labels: ["ui", "tech-debt"] },
      { key: "chore-17", title: "Verify the doctor checks on a fresh directory", status: "todo", assignee: "dsh", labels: ["tech-debt"] },
      { key: "chore-18", title: "Re-read the API boundary notes", status: "todo", assignee: "claude", labels: ["docs", "tech-debt"] },
      { key: "chore-19", title: "Archive the spike fixtures", status: "todo", assignee: "ren", labels: ["tech-debt"] },
      { key: "chore-20", title: "Rotate the development tokens before release", status: "todo", assignee: "dsh", labels: ["security", "tech-debt"] },
    ],
  },
];

export const SEED_DATASET: SeedDataset = {
  participants: SEED_PARTICIPANTS,
  labels: SEED_LABELS,
  items: SEED_ITEMS,
  relationships: SEED_RELATIONSHIPS,
};
