# DSH Integration Environment (Phase D0 inventory)

Recorded 2026-09-04. No DSH files were changed while producing this document.

## Versions

| Component | Version | Source |
| --- | --- | --- |
| DSH (`dsh` CLI, `@deepseek-ai/dsh`) | 0.1.1-rc.2 | `/home/bahman/github/dsh` (`dsh-poc` deployment) |
| `@deepseek-ai/dsh-mcp-client` (bridge) | 0.1.1-rc.2 | installed in web profile `node_modules` |
| Bridge MCP SDK dependency | `^1.12.0` declared, **1.30.0 resolved** | web profile `node_modules` |
| Workboard executable | 0.1.0 (`dist/workboard`, `bun build --compile`) | `/home/bahman/github/agent-workboard` |
| Bun | 1.4.0 | build and test toolchain |
| Negotiated MCP protocol revision | 2025-11-25 | official SDK 1.30.0 client over HTTP (docs/verification.md); the real bridge resolves the same SDK version |

## Workboard server (Mode A — shared Streamable HTTP)

| Item | Value |
| --- | --- |
| Endpoint | `http://127.0.0.1:8765/mcp` (loopback-only default bind) |
| Health | `GET /api/health` → `{"data":{"status":"ok"}}` |
| Data directory | `~/.local/share/workboard` (one board per data directory) |
| Session behavior | Stateless: no `MCP-Session-Id` is ever issued; invalid bearer → `401` |
| Tools exposed | exactly 6: `comment`, `create_work`, `get_work`, `list_work`, `my_work`, `update_work` |

Smoke evidence (official `@modelcontextprotocol/sdk` 1.30.0 client, D0):

- initialize → OK, session id: none (stateless OK)
- `tools/list` → the six tools above
- `my_work` call → `{"items":[],"nextCursor":null}`
- unauthenticated initialize probe → `401 Unauthorized`

## Identity

| Item | Value |
| --- | --- |
| Participant | `dsh-agent` (id 2, kind `agent`), created via `workboard participant add` |
| Token label | `dsh-local-profile` |
| Token storage | `~/.config/workboard/dsh-token.txt` (0600, outside any repository; never committed) |
| Token prefix | `wb_…` (plaintext never recorded here) |
| Planned env name | `WORKBOARD_MCP_TOKEN` (read by the preset's `!!js` header expression) |

## DSH preset landscape

| Item | Value |
| --- | --- |
| Shipped presets | `standard`, `code`, `minimal`, `cordis` (system trust) at `/home/bahman/github/dsh/node_modules/@deepseek-ai/dsh/config/agent-presets/` |
| User preset root | `~/.dsh/.agent-presets/` (authoritative paths come from the roster `list()` probe in Phase D1) |
| Web profile | `~/.dsh/profiles/web` (systemd user unit `dsh.service`, GUI at `http://127.0.0.1:3080`, run as `dsh web --no-open`) |
| Composition editing rule | user patch in `~/.dsh/profiles/web/cordis.patch.yml`; profile root `cordis.yml` stays `[]` |
| Roster copy target | preset id `workboard-agent` (name "Workboard Agent"), copied from `standard` in Phase D1 |

## Notes for later phases

- The Host process reads environment at boot; `WORKBOARD_MCP_TOKEN` must reach
  `dsh.service` (systemd drop-in / EnvironmentFile) before the HTTP bridge row
  is live (Phase D2). A service restart is required once.
- The bridge is protocol-stateless-compatible: no session restoration is
  needed across Workboard restarts.
- Workboard currently runs as a session-managed background process; the
  documentation task covers a durable launch method.
