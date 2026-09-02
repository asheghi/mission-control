# Agent Workboard: DeepSeek Harness Integration Plan

## 0. Purpose

Integrate Agent Workboard with DeepSeek Harness (DSH) in two layers:

1. **Required:** expose Workboard’s MCP tools as native DSH model tools using `@deepseek-ai/dsh-mcp-client`.
2. **Optional after MCP is proven:** add a native Cordis client panel to the DSH web GUI for human visibility and navigation.

The MCP bridge requires no DSH core changes. Prefer configuration and a user-owned agent preset. Treat a GUI plugin as a separate later deliverable.

## 1. Rules for the implementing model

1. Read `docs/research/stateless-mcp.md` and `docs/plans/main-product-implementation.md` first.
2. Inspect the installed DSH version and the actual preset roster before writing configuration.
3. Load DSH’s `editing-cordis-compositions` skill before creating or changing a composition.
4. Never edit a shipped preset or its installed files.
5. Copy the shipped `standard` preset through the preset-authoring service into a new user-owned preset.
6. Use exact paths returned by the DSH preset roster; do not guess `~/.dsh` paths.
7. Keep registries, persistence, credentials, sandbox/approval, model routes, and cross-session services in the Host plane.
8. Agent-specific tool and prompt contributions belong in the agent preset.
9. A preset-owned service provider and all consumers must be in one `isolate` group; do not isolate consumers of Host services.
10. Verify configuration with `standingKeyFor(id)` and then in a real session.
11. Keep all user-facing text and tool instructions in English.

## 2. Confirmed DSH capability

The installed package `@deepseek-ai/dsh-mcp-client` is an MCP client bridge. One Cordis row connects to one MCP server and registers discovered tools on DSH’s `ctx.tools` service.

Public tool names are:

```text
mcp__<serverName>__<rawToolName>
```

For `serverName: workboard`, the expected names are:

```text
mcp__workboard__my_work
mcp__workboard__list_work
mcp__workboard__get_work
mcp__workboard__create_work
mcp__workboard__update_work
mcp__workboard__comment
```

The bridge supports `stdio` and `streamable-http`, startup synchronization, tool list changes, timeout/cancellation, reconnection, and server-qualified name conflict protection.

## 3. Deployment modes

### Mode A — Shared Workboard server over stateless Streamable HTTP (recommended)

```text
DSH session(s)
  → dsh-mcp-client
  → POST http://127.0.0.1:8765/mcp
  → Workboard auth/application service
  → SQLite
```

Use when the browser, CLI, and several DSH sessions share one board. Workboard owns the server and database lifecycle; DSH only connects.

Benefits:

- One database process and one event source.
- Each DSH request authenticates independently.
- No MCP sticky session.
- Workboard restarts do not require restoring an MCP session.
- The same server drives browser SSE updates.

### Mode B — Local Workboard MCP child over stdio

```text
DSH session
  → dsh-mcp-client launches `workboard mcp`
  → local SQLite
```

Use for isolated local boards or development. Do not point several independently spawned stdio children at the same SQLite database unless concurrency tests prove the intended behavior and ownership is documented.

### Decision

Implement and validate both modes, but make **HTTP the documented default for the shared product**. Use stdio for smoke tests and single-session/offline workflows.

## 4. Identity model

Each DSH operational identity maps to one Workboard participant and API token.

Example:

```text
Participant name: dsh-agent
Participant kind: agent
Token label: dsh-local-profile
```

Rules:

- Workboard resolves the actor from the bearer token.
- MCP arguments never include actor, author, or creator IDs.
- Do not create one token per chat session unless audit requirements demand it.
- Prefer one token per DSH Profile or named agent role so it can be revoked independently.
- Do not reuse a human browser token for DSH.
- Token values must enter configuration through environment/settings resolution, not be committed to the repository.

Recommended environment name:

```text
WORKBOARD_MCP_TOKEN
```

Optional additional identities use explicit names:

```text
WORKBOARD_MCP_TOKEN_REVIEWER
WORKBOARD_MCP_TOKEN_PLANNER
```

## 5. Phase D0 — Prerequisite checks

Before configuration, prove:

1. Workboard server starts at the intended URL.
2. `GET /api/health` succeeds.
3. A DSH agent participant and token exist.
4. An official MCP client can initialize, list, and call `my_work` over HTTP.
5. Record the protocol revision negotiated by the actual DSH client. The inspected bridge currently depends on `@modelcontextprotocol/sdk` `^1.12.0`, so expect 2025-era initialization unless an upgraded installation proves modern 2026-07-28 support.
6. In 2025-era compatibility mode, confirm the server does not issue `MCP-Session-Id`; in modern mode, confirm there is no protocol session at all.
7. DSH contains `@deepseek-ai/dsh-mcp-client` and its exact resolved version is recorded.
8. The current DSH agent preset roster can list and copy `standard`.

Create `docs/integration/dsh-environment.md` in Workboard with version numbers, endpoint, preset ID, and non-secret token prefix. Do not record the token.

Acceptance: all checks have commands/output recorded; no DSH files changed yet.

## 6. Phase D1 — Create a user-owned DSH preset

Suggested preset ID: `workboard-agent`. If occupied, choose a similarly clear unique ID.

Use DSH’s preset roster service:

1. Call `list()` and record the real path and trust classification for `standard`.
2. Call `copy('standard', 'workboard-agent', 'Workboard Agent')`.
3. Resolve/read the copied files.
4. Confirm the new preset has `trust: user` and is outside the shipped install.
5. Update copied `preset.yml` description.
6. Retain the standard preset’s existing rows unless a concrete security decision removes one.

Suggested metadata:

```yaml
name: Workboard Agent
description: Full coding agent with authenticated Agent Workboard MCP tools.
```

Never modify the system-trust `standard` directory.

Acceptance:

- shipped preset checksum/status unchanged
- user preset appears in roster
- copied preset parses before adding Workboard

## 7. Phase D2 — Configure HTTP MCP bridge

Add one agent-preset row outside any inappropriate isolate realm. The plugin consumes Host/agent tool infrastructure and should not be moved into a private realm without inspection proving that is required.

Target shape, adjusted only to the exact installed config schema:

```yaml
- id: mcp-workboard
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: workboard
    transport: streamable-http
    url: http://127.0.0.1:8765/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.WORKBOARD_MCP_TOKEN}`'
    toolCallTimeoutMs: 60000
    failOnStartupError: true
    reconnect:
      enabled: true
      initialDelayMs: 500
      maxDelayMs: 30000
      maxAttempts: 10
```

Before saving:

- Verify the loader supports the `!!js` expression syntax in this composition.
- Verify the actual environment reaches the DSH Host process.
- Verify the installed plugin schema uses exactly these keys.
- Ensure `serverName` is unique across all live MCP rows.

Policy choices:

- Development/CI: `failOnStartupError: true` so missing tools fail loudly.
- Interactive production: choose `true` if Workboard is essential; choose `false` if an agent must remain usable while the board is down. Document the decision rather than silently changing it.

Acceptance: preset mount-validation succeeds with Workboard reachable, and validation produces an intentional clear failure or no-tool condition according to selected startup policy when unreachable.

## 8. Phase D3 — Configure stdio variant

Do not place both HTTP and stdio rows live with the same `serverName`. Create either a second preset (`workboard-agent-stdio`) or keep one row disabled as a documented template.

Target shape:

```yaml
- id: mcp-workboard
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: workboard
    transport: stdio
    command: /absolute/path/to/workboard
    args:
      - mcp
      - --dir
      - /absolute/path/to/wb_data
    cwd: /absolute/path/to/project
    env:
      WORKBOARD_TOKEN: !!js process.env.WORKBOARD_MCP_TOKEN
    toolCallTimeoutMs: 60000
    failOnStartupError: true
```

Requirements:

- `command` must be an absolute production executable path.
- `cwd` must be intentional.
- Pass only required extra environment values; rely on DSH’s scrubbed environment behavior.
- Workboard logs go to stderr, never stdout.
- Child exits cleanly on disposal/update/session end.

Acceptance: start session, call a tool, stop session, and prove no orphan Workboard child remains.

## 9. Phase D4 — Agent operating instructions

MCP tool descriptions should carry local usage guidance. Add a small English prompt section or DSH skill only if behavior needs reinforcement across tools.

Required workflow:

1. At the beginning of Workboard-directed work, call `my_work`.
2. Before changing repository files for an accepted item, call `update_work` with `status: doing`.
3. Work only from the item’s stated scope; use a comment to clarify uncertainty.
4. Before `done`, add a concise comment containing:
   - summary
   - primary files changed
   - verification commands and outcomes
   - remaining risks, if any
5. Mark `done` only after required verification passes.
6. If genuinely blocked, set `blocked`, comment with the concrete blocker, and mention the relevant human.
7. Do not create a board item for every ordinary chat request automatically.
8. Do not close/reassign unrelated items.

Recommended skill directory in the copied preset:

```text
skills/workboard/SKILL.md
```

Skill trigger: user asks to work from the board, refers to a Workboard item, asks what is assigned, or asks to report work to the board.

Avoid injecting a long unconditional prompt into every session. A concise tool description plus on-demand skill is cheaper in tokens.

Acceptance: in a new session the skill is discoverable, user-visible text is English, and a scripted model test follows the status/comment order.

## 10. Phase D5 — Mount validation

Use `standingKeyFor('workboard-agent')`; do not use the roster’s `broken` field as proof.

Validation must catch:

- package resolution failure
- invalid plugin config
- rows waiting for missing services
- process-global service publication from a preset
- duplicate MCP `serverName`
- Workboard startup/discovery failure according to policy

Then start a real DSH session using the preset and inspect its actual tool list. Mount validation alone does not prove model-facing schemas or prompt contribution.

Acceptance:

- standing mount returns normally
- real session exposes exactly six `mcp__workboard__*` tools
- no duplicate/raw unqualified Workboard names
- tool descriptions and schemas are readable and bounded

## 11. Phase D6 — End-to-end integration test

Use a clean temporary Workboard data directory and a real DSH session.

Fixture:

- human participant `integration-human`
- agent participant `integration-dsh`
- separate tokens
- one item created by human and assigned to agent

Test sequence:

1. Open Workboard browser UI as human.
2. Create an item with a unique test marker and assign `integration-dsh`.
3. In DSH call `mcp__workboard__my_work`; assert the item appears with `assigned: true`.
4. Call `update_work` to set `doing`.
5. Verify browser updates through SSE without refresh.
6. Call `comment` with summary and test marker.
7. Call `update_work` to set `done`.
8. Fetch detail in browser/REST.
9. Assert created-by, comment author, and all history actors are correct.
10. Assert `closed_at` exists.
11. Restart Workboard and call `get_work` again without an MCP session restore.
12. Run two DSH/client identities concurrently and confirm attribution never crosses.

Record evidence in `docs/integration/dsh-verification.md`.

Acceptance: every assertion passes against the compiled Workboard executable and the actual DSH MCP client bridge.

## 12. Phase D7 — Failure, lifecycle, and security tests

### Workboard unavailable at DSH startup

Verify behavior matches `failOnStartupError`. User-visible logs must identify `workboard` without exposing headers.

### Workboard restarts

The DSH bridge should reconnect with bounded exponential backoff. Last registered tools may remain visible but calls can fail during outage; document this UX. After recovery, call succeeds without duplicate tools.

### Invalid/revoked token

Calls fail safely and do not leak token, digest, or participant existence. Rotate token by updating the environment/settings source and restarting/reloading the relevant DSH composition.

### Timeout/cancellation

Force one delayed test tool/service path, cancel the DSH call, and prove request work and transport resources stop. Do not leave a SQLite transaction open.

### Origin and binding

Workboard defaults to loopback. If remote, use TLS and an explicit origin/host policy. DSH is a native client and may omit `Origin`; Workboard policy must explicitly allow absent origin for authenticated non-browser clients while rejecting present invalid origins.

### Tool collisions

Start a second row with `serverName: workboard`; verify it fails loudly and does not partially replace tools.

### Disposal

Stop the DSH session/preset and verify all six tool registrations disappear and any stdio child terminates.

Acceptance: all cases recorded with expected and actual outcome.

## 13. Observability

Workboard logs structured fields:

- request ID
- transport (`rest`, `mcp-http`, `mcp-stdio`, `cli`)
- MCP tool name
- participant ID, never token
- item ID where relevant
- duration
- stable outcome/error code

DSH bridge logs connection, discovery, reconnect attempt, recovery, and terminal disablement. Do not duplicate full tool inputs into logs because comments/bodies may contain sensitive text.

Correlate calls by returning a request ID in structured MCP results and including it in Workboard logs. DSH need not alter its core tracing for v1.

Acceptance: one E2E call can be traced across DSH-visible tool result and Workboard log without revealing credentials.

## 14. Rollout and rollback

### Rollout

1. Release Workboard executable with REST and MCP contract tests.
2. Deploy server loopback-only.
3. Create agent participant/token.
4. Create and mount-validate user preset.
5. Start one canary DSH session.
6. Run read-only `my_work` and `get_work` calls.
7. Run controlled mutation E2E.
8. Make preset available to normal sessions.
9. Monitor reconnect/auth/domain error rates.

### Rollback

- Stop using the custom preset or stop its run/session.
- Return to shipped `standard`; it remains untouched.
- Revoke the Workboard DSH token if compromise is suspected.
- Keep Workboard data; configuration rollback must not delete the SQLite file.
- If a preset update fails, restore the last known-good user preset file/package rather than editing shipped DSH assets.

Acceptance: rollback removes Workboard tools from a new session while standard DSH tools remain available and Workboard data remains intact.

## 15. Optional native DSH GUI integration

Do not start this until MCP phases D0–D7 pass. This is a separate Cordis plugin, not a reason to change DSH core.

### User-visible scope

A small “Workboard” panel can show:

- current participant
- assigned/open item count
- compact assigned-item list
- status and priority
- button/link to open the Workboard web UI
- manual refresh and connection/error state

Avoid reproducing the entire Kanban board inside DSH. The Workboard web app remains the authoritative human UI.

### Architecture and installation plane

Build a static, versioned Cordis package under `integrations/dsh-workboard/`; do not ship the GUI as a temporary dynamic Package. Suggested files are `package.json`, `lib/index.js` for Host, `lib/client.js` for Client, tests, and `README.md`.

- Install it into the DSH **Host/profile plane**, because browser modules, credentials, live board state, and shell UI are shared across sessions. Do not place it in the agent preset.
- The Host half owns authenticated HTTP calls to Workboard so browser code never receives the API token.
- The Client half registers additive UI in an inspected DSH Slot; never replace the root, conversation, sidebar, or details shell.
- Use product-grade generated Remote contracts or tightly scoped same-origin Host JSON/SSE routes. Dynamic Package `harness.handle`/`host.call` is only for temporary runtime extensions and is not the shipping interface.
- Client receives only bounded, minimal owned DTOs.
- Optional live updates use a Host-managed Workboard SSE connection with lifecycle-bound teardown.

Inspect the live Host and Client providers before coding; do not guess Services, Events, Slots, props, tokens, or Remote signatures. The current profile’s writable composition overlay must be discovered and edited according to its own instructions (the inspected deployment uses `/home/bahman/.dsh/profiles/web/cordis.patch.yml`); never edit the profile root or installed shell composition to bypass that overlay.

### Mandatory implementation workflow

1. Load the applicable Cordis development/composition and real-browser verification skills.
2. Inspect exact Host services for networking, settings/credentials, logging, routes/Remote, and lifecycle.
3. Inspect the Client Slot tree, exact selected Slot contract, theme tokens, and React/runtime APIs.
4. Implement Host and Client package exports with exact DSH client metadata.
5. Own every listener, route, timer, stream, slot registration, and abort controller through the Cordis lifecycle.
6. Test Host route validation, auth redaction, bounded responses, and teardown.
7. Build the client bundle.
8. Install with `dsh plugin --profile web add file:<absolute-package-path>` and add only its row to the profile’s user patch composition.
9. Restart the existing Web profile, refresh the existing `http://127.0.0.1:3080`, and do not start a replacement server.
10. Verify loading, empty, error, success, live-update, keyboard, accessibility, and unmount/remount behavior with the required real-browser web-tester.
11. Completion requires explicit `VERDICT: PASS` plus evidence.

### Safety constraints

- Validate Workboard origin/URL.
- Never send credentials to Client.
- Do not serialize Cordis live objects.
- Bound response size and item count.
- Abort Host calls and SSE on plugin stop/update.
- A Client row throwing on first render can be abdicated and silently hidden; test error/loading/empty/success render paths explicitly.

Acceptance:

- plugin stop removes panel, listeners, styles, and network activity
- error state remains visible rather than throwing
- real-browser tester reports PASS
- no token appears in browser storage, DOM, logs, or network payload returned by private RPC

## 16. Exact implementation task list for a cheaper model

Execute each as a separate change with verification:

1. **Inventory:** record DSH, MCP client, Workboard, Bun, and protocol versions.
2. **Workboard participant:** create DSH participant and token; store token outside repository.
3. **HTTP smoke:** call Workboard MCP with official client and verify stateless behavior.
4. **Roster inspect:** list presets and identify real shipped `standard` path/trust.
5. **Preset copy:** create user preset and verify shipped files unchanged.
6. **Metadata:** set English name/description.
7. **MCP row:** add HTTP bridge using exact inspected schema.
8. **Mount validate:** run `standingKeyFor`; fix all activation issues.
9. **Real session:** select preset and verify six tools.
10. **Skill:** add concise on-demand Workboard workflow instructions.
11. **Read E2E:** `my_work` and `get_work` against fixture.
12. **Write E2E:** doing → comment → done and verify browser/history.
13. **Resilience:** restart server, revoke token, timeout/cancel, reconnect, duplicate-name tests.
14. **stdio preset/template:** validate child lifecycle and stdout purity.
15. **Documentation:** configuration, token rotation, troubleshooting, rollback.
16. **Optional GUI design:** inspect Host/Client capabilities and choose an additive Slot and Host/profile installation path.
17. **Optional GUI implementation:** build/test a static Host+Client Cordis package under `integrations/dsh-workboard/`, install it only in the profile user patch, and verify teardown.
18. **Optional GUI browser verification:** refresh the existing DSH GUI and require a real-browser `VERDICT: PASS` gate.

A task is complete only when its acceptance evidence is written. Do not infer success from configuration parsing alone.

## 17. Definition of done

Required DSH integration is done when:

1. Shipped DSH presets are unchanged.
2. A user-owned Workboard preset mount-validates.
3. A real DSH session exposes exactly six namespaced Workboard tools.
4. DSH completes an assigned item lifecycle against the compiled server.
5. Browser SSE reflects changes live.
6. History and comments identify the DSH participant derived from its token.
7. Stateless HTTP survives a Workboard restart without session restoration.
8. Token revocation, outage, reconnect, timeout, cancellation, and disposal behaviors are verified.
9. Rollback to standard removes the integration without deleting Workboard data.
10. Setup, token rotation, troubleshooting, and rollback are documented in English.

The optional GUI is done only after its separate real-browser PASS and lifecycle teardown checks succeed.
