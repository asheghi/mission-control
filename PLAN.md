# Agent Workboard - Implementation Plan

**Product:** A local coordination broker for one Git repository. It assigns work
to 2-10 coding agents across Codex CLI, Claude CLI, Hermes, and similar harnesses;
gives each claim an isolated or explicitly attached Git worktree; and records the
branch and commit that came back.

**Architecture:** One server process owns SQLite. Local CLI/MCP adapters own Git
operations because repository paths and worktrees are host-local. The browser is
a REST client and never touches Git or SQLite.

**Stack:** Bun 1.4.0, strict TypeScript, `bun:sqlite`, official MCP SDK, Zod,
React, and shadcn/ui. `bun build --compile` produces one executable.

**Status:** Draft 3. Nothing described here is implemented yet.

---

## 1. Product boundary

Agent Workboard solves three concrete failures in concurrent coding-agent work:

1. two agents start the same task;
2. two agents mutate the same working directory;
3. an agent stops and nobody can tell where its partial work lives.

The core loop is:

```text
claim -> provision or attach worktree -> work -> submit branch/head commit
                                      \-> interrupt -> inspect -> resume/abandon
```

It does **not** execute an agent, merge branches, resolve merge conflicts, promise
that two isolated branches will merge cleanly, or replace GitHub Issues/Jira for
organization-wide planning. Worktree isolation prevents filesystem overwrites;
Git still owns integration.

One deployment coordinates one repository. Multi-repository boards are deferred
until real use proves they are needed.

### Two workspace modes

- **Managed:** the local adapter creates a branch and worktree for the claim.
- **Attached:** an agent already running in a worktree registers that worktree.

Creating a worktree does not automatically change an already-running harness's
working directory. Managed mode is supported only where the harness integration
can bind subsequent commands to the returned path and prove that binding. A
harness without that capability must start in a prepared worktree and use attached
mode. An optional harness launcher is a later feature, not an assumed capability.

The server stores portable facts (`repo_id`, `host_id`, branch, base commit, head
commit). A filesystem path is host-local metadata and is never assumed usable on
another machine.

---

## 2. Baseline before code

The project starts with evidence, not scaffolding.

For two working days, run at least two existing harnesses concurrently against a
named, actively developed repository and its real backlog. Do not use building
Agent Workboard as the corpus.

Record in `docs/baseline.md`:

| Measure | Count or duration |
|---------|-------------------|
| Tasks attempted/completed | workload size |
| Duplicate task starts | assignment failures |
| Shared-working-directory incidents | overwritten or disrupted work |
| Stranded partial work | result could not be located/resumed |
| Manual coordination interventions | human messages/actions |
| Workspace setup time | branch/worktree overhead |
| Result-location time | time to find branch/commit/output |

Before the run, name the repository and define the minimum improvement that would
justify maintaining another tool. Proceed only if the baseline shows a repeated
failure or enough manual coordination cost to repay the tool's maintenance.

**Stop condition:** if concurrent work is already reliable and cheap with current
worktrees and conventions, do not build Agent Workboard.

---

## 3. System shape

```text
                         portable REST state
 browser ---------------------> workboard serve
                                   |  SQLite owner
                                   |  leases/events/history
                                   |
 Codex/Claude/Hermes host          |
   workboard mcp/cli --------------+
          |
          +-- local Git repository
          +-- managed or attached worktrees
```

### Server responsibilities

- deterministic, exclusive work assignment;
- claim timestamps, state, identity, and history;
- item and comment APIs;
- revisions and replay protection where retries are dangerous;
- browser events;
- backup and migrations.

### Adapter responsibilities

- discover and validate the local repository;
- create or attach a worktree;
- activate a reserved claim only after workspace validation;
- renew active claims in the background without asking the LLM;
- report branch/base/head commits;
- release clean failed provisioning attempts;
- preserve and expose interrupted workspaces.

The MCP adapter releases a provisioning reservation on graceful setup failure. A
normal stdio shutdown marks active work interrupted unless it was explicitly
submitted or safely abandoned. `SIGKILL` cannot send a final REST call, so lease
expiry is the backstop.

---

## 4. Repository and workspace identity

`workboard init` binds the data directory to one logical repository and returns a
`repo_id`. Adapters register each clone/host installation using:

- `host_id`: random stable identifier in the local Workboard config;
- normalized `origin` when one exists;
- Git common-directory identity and current root;
- default base branch configured at init.

Paths are stored with `host_id`. The API may return them to that host for recovery,
but UI and other hosts treat them as informational only.

### Managed worktree rules

For a reservation `<item-id>/<claim-attempt>`, the adapter:

1. resolves the configured base ref to an immutable `base_commit`;
2. chooses `wb/<item-id>-<slug>-<claim-suffix>` as the branch;
3. chooses a path under a configured Workboard worktree root;
4. refuses a colliding branch or path rather than resetting either;
5. runs `git worktree add -b <branch> <path> <base_commit>` without a shell;
6. asks the harness integration to adopt that path and verifies it;
7. activates the claim with host, path, branch, and base commit.

If creation fails, the adapter reports `provision_failed`; the short reservation
is released and the error is retained in history. It never uses `-B`, resets an
existing branch, deletes an existing directory, or silently prunes worktrees.
The adapter journals a pending local provision before invoking Git, reconciles it
on restart, and does not expose the task to the harness until activation succeeds.

### Attached worktree rules

The adapter resolves `git rev-parse --show-toplevel`, verifies that it belongs to
the configured repository, and records its branch and base commit. MVP attached
mode requires a named branch and a clean worktree at claim start. This gives the
claim an unambiguous before-state; overrides are deferred.

### Submission and cleanup

Submission requires:

- the registered worktree still exists on the claiming host;
- it is clean;
- `HEAD` differs from the recorded base commit;
- the claim token matches and has not expired;
- branch and head commit are recorded with the result summary.

Submission changes the item to `submitted`. It means "the agent produced a Git
result", not "the branch is merged".

MVP never removes a worktree or branch automatically. Cleanup is an explicit local
command added only after its safety checks are specified and tested. Preserving a
worktree costs disk; deleting the only copy of partial work costs the project.

---

## 5. State model

### Work item status

```text
ready -> doing -> submitted
           |
           +-> interrupted -> doing      (resume)
                          \-> ready       (verified abandon)

submitted -> ready                       (reopen)
```

- `ready`: eligible for reservation.
- `doing`: a provisioning or active claim exists.
- `interrupted`: the lease ended without a safe disposition; partial work may
  exist and the item is not claimable.
- `submitted`: branch/head result recorded. Merge/review remains in Git tooling.

Blocking and dependency graphs are not in the MVP. They can be added as a separate
axis after dogfooding; they will not become another status.

### Claim state

```text
provisioning -> active -> submitted
      |            |
      +-> failed   +-> released       (only after safe abandon)
                   +-> interrupted    (disconnect/expiry)
```

`claim_count` increments when a reservation is created. Every terminal claim
state records an outcome and reason, so repeated failures can be measured before
adding automatic poison-item policy.

### Interruption recovery

An expired active claim becomes `interrupted`; it does **not** automatically return
to `ready`. The server cannot know whether a host-local worktree contains commits
or uncommitted changes.

On the owning host, `workboard recover <item>` inspects the registered workspace:

- existing work: reattach and resume with a new claim token;
- clean and unchanged from base: safely abandon and return to `ready`;
- missing workspace: record that fact and allow an explicit recovery decision;
- dirty or committed partial work: refuse automatic abandonment.

An admin can force abandonment, but the API and UI must state that this may orphan
host-local work. No recovery operation deletes files.

---

## 6. Data model

SQLite uses WAL, `foreign_keys=ON`, `synchronous=NORMAL`, and
`busy_timeout=5000`. Numbered embedded migrations run transactionally and are
tracked with `PRAGMA user_version`.

### Primary tables

**`work_items`**

`id`, `client_id` (unique UUID), `title`, `body`, `status`, `priority`, `revision`,
`claimed_by`, `claim_token_digest`, `claim_state`, `lease_expires_at`,
`claim_count`, `active_workspace_id`, `created_at`, `updated_at`.

**`workspaces`**

`id`, `item_id`, `claim_attempt`, `mode`, `repo_id`, `host_id`, `path`, `branch`,
`base_commit`, `head_commit`, `state`, `created_at`, `submitted_at`.

**Supporting tables**

`participants`, `api_tokens`, `comments`, `history`, `claim_requests`, `events`,
`repositories`, and `hosts`.

History is append-only application history, not tamper-evident security logging.
All domain changes and their history entries occur in one SQLite transaction.

---

## 7. Claim correctness and leases

The server is the only database owner, but exclusivity is still enforced by the
write itself so a future `await`, refactor, or second connection cannot weaken it.

Reservation uses one guarded statement inside the transaction:

```sql
UPDATE work_items
SET claimed_by = :participant_id,
    claim_token_digest = :token_digest,
    claim_state = 'provisioning',
    lease_expires_at = :provision_deadline,
    claim_count = claim_count + 1,
    status = 'doing',
    revision = revision + 1,
    updated_at = :now
WHERE id = (
  SELECT id
  FROM work_items
  WHERE status = 'ready' AND claimed_by IS NULL
  ORDER BY priority DESC, created_at ASC, id ASC
  LIMIT 1
)
AND status = 'ready'
AND claimed_by IS NULL
RETURNING *;
```

The raw claim token is returned once; only its digest is stored. The guarded write
is the guarantee. JavaScript event-loop timing is not part of the proof.

### Lease behavior

- Provisioning reservation: 60 seconds by default.
- Active lease: 10 minutes by default.
- Adapter heartbeat: every 2 minutes, with jitter.
- The adapter renews automatically while it owns an active claim.
- Every owner operation first treats an expired timestamp as expired.
- Server startup reconciles expired reservations/claims.
- A timer targets the nearest expiry; it is an optimization, not correctness.
- No cron expression or LLM-issued `renew` is required.

A provisioning expiry returns the item to `ready` because the task is not exposed
to the harness before activation; the adapter's local pending journal retains any
clean orphaned worktree for reconciliation. An active expiry becomes
`interrupted` because agent work may exist.

A graceful adapter shutdown reports interruption. An ungraceful death is detected
at expiry. Network partitions cannot be distinguished from process death, so both
use the same conservative interrupted state.

---

## 8. Retry, revision, and identity contracts

Do not build generic idempotency middleware for every mutation.

- `create_item` and `add_comment` carry client-generated UUIDs with unique
  constraints. Repeating them returns the existing resource.
- `claim-next` carries `request_id`; `(participant_id, request_id)` stores and
  replays the same claim result so a lost response cannot claim a second item.
- `activate`, `heartbeat`, `release`, and `submit` are defined as idempotent for
  the same claim token and payload.
- Human/item edits use `If-Match: <revision>`; stale revisions return
  `409 stale_revision` with the current item.

Errors use one envelope:

```json
{
  "error": {
    "code": "workspace_dirty",
    "message": "The worktree must be committed before submission.",
    "details": {}
  }
}
```

### Identity and threat model

API tokens are bound to participants; actor identity is never accepted in request
bodies. Use high-entropy `<token-id>.<secret>` tokens, look up the token ID, store
a SHA-256 digest of the secret, and compare it in constant time. A password
KDF is unnecessary for random tokens and adds avoidable latency.

MVP protects network access and provides attribution among cooperating clients.
It does not protect the audit trail from a coding agent that runs as the same OS
user and can directly read or modify the database or token files. Documentation
must not call the history tamper-proof.

Initial permissions are `user` and `admin`; detailed scopes and expiry policy are
earned during operational hardening.

---

## 9. Markdown and browser safety

The browser renders Markdown to React elements using a browser-compatible library
such as `react-markdown`:

- raw HTML support is not installed/enabled;
- React escapes text content;
- custom link components allow only relative, `http`, `https`, and `mailto` URLs;
- images are disabled in MVP;
- external links get `rel="noopener noreferrer"`;
- CSP disallows inline scripts and `eval`.

Do not render an HTML string and repair it afterward. A Playwright payload corpus
must verify the actual browser DOM and navigation behavior, including `javascript:`,
`data:`, encoded schemes, raw tags, SVG, malformed links, and event attributes.

---

## 10. APIs and tools

### Server REST API (MVP)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/items` | Create with `client_id` |
| GET | `/api/items` | List by status/participant |
| GET | `/api/items/:id` | Item, current claim, workspace result, comments/history |
| PATCH | `/api/items/:id` | Edit/reopen with `If-Match` |
| POST | `/api/claims/next` | Reserve next item with `request_id` |
| POST | `/api/items/:id/claim/activate` | Attach validated workspace metadata |
| POST | `/api/items/:id/claim/heartbeat` | Extend active lease |
| POST | `/api/items/:id/claim/submit` | Record branch/head and mark submitted |
| POST | `/api/items/:id/claim/release` | Safe failed provisioning/abandon |
| POST | `/api/items/:id/claim/interrupt` | Graceful disconnect with work preserved |
| POST | `/api/items/:id/recover` | Resume or explicitly abandon interrupted work |
| POST | `/api/items/:id/comments` | Add with `client_id` |

### Local adapter commands/tools

The MCP tool is coarse-grained: `claim_work` performs reservation, local Git
provisioning/attachment, and activation as one user-facing operation. The LLM does
not manually orchestrate those REST steps.

MVP tools/commands:

`list_work`, `get_work`, `create_work`, `claim_work`, `submit_work`,
`release_work`, `recover_work`, `comment`, and `status`.

Heartbeat is adapter-internal. CLI exposes diagnostics but ordinary agent prompts
should not need lease knowledge.

---

## 11. Implementation phases

### Phase 0 - Baseline (2 working days, no product code)

Run the existing concurrent-agent workflow on one named real repository. Commit
`docs/baseline.md` with the predefined measures and go/no-go threshold.

**Gate:** no demonstrated problem means stop.

### Phase 1 - Hostile throwaway spike (up to 3 days)

Prove the risky mechanisms, not the packaging trivia:

1. Three real client processes race `claim-next` through one HTTP server over 100
   items: exactly 100 unique claims, including an injected real event-loop yield.
2. The guarded SQL remains correct if a second test connection races it.
3. Each real harness that claims managed-mode support adopts its returned path;
   a marker written by the harness lands in that worktree and not the original
   checkout. Two harnesses then edit the same path without filesystem interference.
4. Branch/path collisions fail without reset or deletion.
5. `SIGKILL` an MCP adapter: renewal stops, expiry marks the item interrupted,
   and the worktree remains on disk.
6. Graceful adapter shutdown reports interruption immediately.
7. Recovery resumes a dirty/committed worktree and safely abandons only an
   unchanged one.
8. Browser-side Markdown payloads remain inert with URL filtering.
9. Official MCP SDK works from the compiled executable with a real harness.

Spike code is disposable. Preserve only results in `docs/spike-results.md`.

**Gate:** any failed safety invariant changes the design before Phase 2.

### Phase 2 - Thinnest real slice

Build only:

```text
create/list -> claim -> managed or attached workspace -> auto-heartbeat
            -> submit branch/head
            -> interrupt/recover/release
```

Packages: `core`, `client`, `server`, `cli`, and `mcp`. No browser, themes,
notifications, hierarchy, blockers, or cross-platform service installer.

**Exit:** Codex CLI, Claude CLI, and Hermes can each complete the loop against the
compiled binary on the baseline repository.

### Phase 3 - Controlled dogfood comparison

Use the tool on comparable real work for one week. Record the same baseline
measures plus claim failures, interrupted recoveries, and incorrect workspace
metadata. No feature work during the measurement window; fix only blocking bugs.

**Gate:** continue only if duplicate starts/shared-tree incidents fall to zero and
human coordination or result-location time materially improves. A preference
question is not evidence.

### Phase 4 - Minimal web board

Only after the comparison passes: four compact views (`ready`, `doing`,
`interrupted`, `submitted`), item detail, comments, claim/workspace metadata, and
explicit recovery warnings. Use stock shadcn through `packages/ui`. Add resumable
SSE events and Playwright tests against the compiled binary.

### Phase 5 - Operational hardening

- automatic pre-migration snapshot and tested restore;
- migrations from every released schema version;
- token administration and file-permission checks;
- service install/status/uninstall for the actual deployment platform;
- structured logs, `workboard doctor`, version/support output;
- explicit safe workspace cleanup workflow.

### Phase 6 - Earned extras

Potentially: dependency blocking, PR provider links, merge-status reconciliation,
notifications, design-system themes/playground/lint governance, multiple
repositories, and additional build targets. Each needs evidence from dogfooding.

---

## 12. Testing contract

| Area | Required evidence |
|------|-------------------|
| Claim exclusivity | Real HTTP clients plus direct second-connection adversarial test |
| Yield safety | Inject real timer/I/O yields around application code; guarded SQL remains exclusive |
| Retry safety | Lost-response simulation for claim/create/comment |
| Worktree isolation | Two managed worktrees edit identical paths without filesystem interference |
| Harness adoption | Codex, Claude, and Hermes write inside the claimed path or fall back to attached mode |
| Git safety | Existing branch/path, dirty attach, detached HEAD, missing repo, failed add |
| Crash recovery | `SIGKILL`, server restart, host unavailable, dirty and committed partial work |
| Submission | Dirty tree rejected; clean changed head recorded; repeat is idempotent |
| Persistence | Disk-backed WAL database, restart, migration, backup/restore equality |
| MCP | Real Codex, Claude, and Hermes invocation, not only mocked protocol tests |
| Browser | Playwright on compiled binary, including Markdown/XSS corpus and recovery UI |

No test may claim to prove the architecture while bypassing its server boundary.
Unit tests may use in-memory SQLite; durability and concurrency tests may not.

---

## 13. Success criteria

- [ ] A baseline from a real repository justifies building the tool.
- [ ] Setup to first isolated claim takes under five minutes.
- [ ] Three harnesses racing through REST never receive the same item.
- [ ] Managed claims never share a working directory.
- [ ] Every managed-mode harness proves subsequent commands run in the claimed path.
- [ ] Attached claims validate repository, branch, and clean before-state.
- [ ] The LLM never needs to call `renew`; the adapter maintains its lease.
- [ ] Killing an adapter preserves its worktree and marks work interrupted.
- [ ] Interrupted partial work can be located and resumed.
- [ ] No automatic path deletes a worktree or branch.
- [ ] Retrying a lost claim response returns the original claim.
- [ ] Submission records the exact branch, base commit, and head commit.
- [ ] The product never claims to prevent Git merge conflicts.
- [ ] Dogfood comparison shows zero duplicate starts/shared-tree incidents and a
      material reduction in human coordination or result-location time.
- [ ] The compiled artifact passes the full real-process test suite.

---

## 14. Reviewer questions

1. Is `interrupted` the correct conservative result of lease expiry, or is there
   a safe way to make unchanged workspaces automatically claimable across hosts?
2. Is clean-at-start too restrictive for attached mode, or is relaxing it worth
   losing an unambiguous base state?
3. Should the first release remain one repository per data directory, or does the
   real baseline require several repositories immediately?
4. Are a 60-second provisioning reservation, 10-minute active lease, and
   2-minute automatic heartbeat reasonable defaults after the hostile spike?
5. What exact measured improvement over `docs/baseline.md` justifies continued
   maintenance after the one-week comparison?
