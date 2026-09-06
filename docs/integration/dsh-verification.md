# DSH — Agent Workboard integration: verification evidence (D0–D7)

Dates: 2026-09-04 → 2026-09-06. Host: DSH 0.1.1-rc.2 (`web` profile as world
`dsh.service`), Workboard 0.1.0. Every row lists the command or log that can
be re-run independently. Logs preserved under `.tmp/` where noted; board
tokens never leave the host.

| Phase | Claimed check | Evidence |
| --- | --- | --- |
| D0 | Env inventory | `docs/integration/dsh-environment.md` (commit `fb74551`). |
| D0 | MCP identity + smoke | Official SDK client: 6 tools listed (`comment`, `create_work`, `get_work`, `list_work`, `my_work`, `update_work`), stateless (no `MCP-Session-Id` negotiated), `my_work` call OK, bad bearer → 401. Script `.tmp/d0-mcp-smoke.ts`, rerun green after every restart. |
| D1 | User preset copy | `.tmp/d5-validate.log`: roster `list()` shows 4 shipped presets (`trust: system`, paths under `node_modules/@deepseek-ai/dsh/config/agent-presets/`) plus `workboard-agent` (`trust: user`, path `~/.dsh/.agent-presets/workboard-agent/agent.cordis.yml`, English `name`/`description`). |
| D2 | HTTP MCP bridge row | Composition row (see `dsh-setup.md` §4) parses (`!!js` header) and mounts: `standingKeyFor('workboard-agent')` → `"OK"`; the whole preset subtree (bridge + skill) validates in the headless host composition. |
| D2 | Token reaches Host | `tr '\0' '\n' < /proc/<dsh PID>/environ | grep '^WORKBOARD_MCP_TOKEN=wb_'` → 1 (via drop-in `dsh.service.d/workboard.conf` + `~/.config/workboard/workboard.env` 0600). Confirmed after every restart. |
| D3 | stdio variant | Raw JSON-RPC to `workboard mcp`: `initialize` + `tools/list` succeed on stdout, banner only on stderr (55 B), child holds `my_work`-capable queue; `.tmp/d3-validate.log`: `workboard-stdio` **mounted OK** in the host composition (roster `trust: user`). |
| D4 | Skill | `skills/workboard/SKILL.md` ships inside both presets; the session flow shows `skill-catalog` context injection and the agent obeys the claim→doing→comment→done cadence (D6 drive). |
| D5 | Real session six-tool check | Real DSH session on `workboard-agent` chip (Playwright over the GUI): session-header label "Workboard Agent"; agent enumerated exactly `mcp__workboard__{comment,create_work,get_work,list_work,my_work,update_work}` (no duplicates, no extras) and called `mcp__workboard__my_work · {}` → result `{"items":...,"nextCursor":null}`. Screenshot `.tmp/webtest/gui-session-tools.png`. |
| D6 | E2E lifecycle | Throwaway board (fresh SQLite at `/tmp/...`, participants `integration-human`/`integration-dsh` + tokens). Fixture: marker `WB-E2E-1788688662`, REST create with bearer of the human → `createdBy:2`, assigned `id:3`. Real DSH session: `my_work` confirms assignment, `update_work` → `doing`, `comment` (author `integration-dsh`, id 3), `update_work` → `done` (verbatim `closedAt` from agent). Board SSE watcher (`.tmp/e2e-sse-watch.cjs`, `/tmp/wb-e2e-sse.log`) observed `todo → doing → done` on the card WITHOUT reload: 1788689539 `doing`, 1788689541 `done`. |
| D6 | Attribution isolation | Two identifiers used the same board concurrently (`integration-human` via REST + browser; `integration-dsh` via MCP): detail shows `createdBy: 2`, comment author id 3, history rows `created` actor `integration-human`, status transitions actor `integration-dsh`; actors never cross. |
| D6 | `closed_at` recorded on done | REST detail `'status':'done', 'closedAt':'2026-09-06T10:12:20.563Z'`. |
| D7 | Stateless restart | Server killed mid-session (health refused ≈6 s), restarted: `get_work · {"id":1}` from the continued DSH session returned `status:"done", closedAt:"2026-09-06T10:12:20.563Z"` straight from the restored SQLite — no MCP session, no SSE replay. |
| D7 | Token revocation | `token revoke --id 2` (integration-dsh) → next `my_work` fails immediately, verbatim `UNAUTHENTICATED` from the agent; no partial bookkeeping. |
| D7 | Rotation | Env-file swap + service restart moved the bridge from the `dsh-agent` token to the `integration-dsh` token: previous turn all calls failed closed `UNAUTHENTICATED`, after rotation the same session completed the full lifecycle (D6). |
| D7 | Duplicate serverName | Live probe mount of `workboard-stdio` then `workboard-agent` in ONE composition: second variant refused ("serverName \"workboard\" collides with an existing mcp-client instance"), first mounted OK. |
| D7 | Timeout/cancel + reconnect config | `toolCallTimeoutMs: 60000`, `reconnect{enabled,500,30000,10}` accepted by the bridge schema at mount (standing OK); HTTP failures retry per request (documented in bridge README §115); lay D6/D7 restart test exercised the reconnect path live. Body/read hardening of the server itself covered by repo tests (401-before-read, 413 maladjusted, SSE slow-consumer disconnect). |

Residual notes:

- Every phase also held against the official SDK smoke (re-run after each
  restart of the server or `dsh.service`).
- The durable installables promoted during D6 (workboard.service unit,
  env file, drop-in, presets, skill) are documented in `dsh-setup.md`.
