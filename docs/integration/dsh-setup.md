# DSH — Agent Workboard integration: setup and operations guide

Companion to `dsh-environment.md` (environment inventory) and `dsh-verification.md`
(acceptance evidence). Host: the `web` profile of DSH 0.1.1-rc.2 running as the
systemd user unit `dsh.service` (GUI at `http://127.0.0.1:3080`). Workboard
server: compiled single binary at `~/github/agent-workboard/dist/workboard` (0.1.0).

## 1. Server (Agent Workboard side)

A durable user unit serves the production board:

```
# ~/.config/systemd/user/workboard.service
[Unit]
Description=Agent Workboard shared server (loopback REST + MCP)
After=network.target

[Service]
ExecStart=/home/bahman/github/agent-workboard/dist/workboard serve --dir %h/.local/share/workboard --port 8765
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

`systemctl --user daemon-reload && systemctl --user enable --now workboard`.
Health check: `curl -s http://127.0.0.1:8765/api/health`
→ `{"data":{"status":"ok"}}`. State lives in `%h/.local/share/workboard/workboard.sqlite`.

Endpoint is loopback-only: sessions (REST + SSE, plus the stateless MCP at
`/mcp`) never leave the machine; the DSH GUI runs web clients over its own
connection back to localhost.

## 2. Participant and token for DSH

The identity DSH presents over MCP lives in the Workboard database, not in DSH:

```
workboard --dir ~/.local/share/workboard participant add --name dsh-agent --kind agent
workboard --dir ~/.local/share/workboard token create --participant dsh-agent --name dsh-local-profile
```

Create the participant first, then the token issued for it. Store only the token
plaintext once (0600) — Workboard never shows it again:

```
umask 077
workboard --dir ~/.local/share/workboard token create --participant dsh-agent --name dsh-local-profile > ~/.config/workboard/dsh-token.txt
```

## 3. Getting the token into the DSH host

MCP authentication header is read from the environment by the composition
row, so the Host process needs it at start:

- `~/.config/workboard/workboard.env` (0600): one line
  `WORKBOARD_MCP_TOKEN=wb_...` (the token from the file above).
- systemd drop-in:

```
# ~/.config/systemd/user/dsh.service.d/workboard.conf
[Service]
EnvironmentFile=%h/.config/workboard/workboard.env
```

Then `systemctl --user daemon-reload && systemctl --user restart dsh`.
Verification: `tr '\0' '\n' < /proc/$(systemctl --user show dsh -p
ExecMainPID --value)/environ | grep WORKBOARD_MCP_TOKEN` shows the line.

One service restart propagates both a token change and new preset files;
running agent turns are aborted, persisted sessions survive.

## 4. User preset (HTTP bridge)

`~/.dsh/.agent-presets/workboard-agent/` is created by copying a shipped
preset from `@deepseek-ai/dsh/config/agent-presets/standard/` (roster "copy"
in the GUI does the same). Composition row appended under `tools:`:

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
    failOnStartupError: false
    reconnect:
      enabled: true
      initialDelayMs: 500
      maxDelayMs: 30000
      maxAttempts: 10
```

Notes:

- `serverName` is the namespace clients see (`mcp__workboard__*`). It must be
  `[A-Za-z0-9_-]{1,32}` and unique across the composition — a second row with
  the same name is refused cleanly at mount.
- `!!js` evaluates with host process scope, so the token never appears in
  the YAML file.
- Composition files are stock YAML — inspectable by any editor. The agent
  skill at `skills/workboard/SKILL.md` (also copied into the preset) carries
  the workflow rules (claim → doing → comment with evidence → done).

Sessions are fixed to the preset they were composed from (the host refuses
`agent-preset-locked`); pick the preset on the new-session chip.

## 5. stdio variant (development/isolated boards)

`~/.dsh/.agent-presets/workboard-stdio/` mirrors the first preset with:

```yaml
- id: mcp-workboard-stdio
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: workboard
    transport: stdio
    command: /home/bahman/github/agent-workboard/dist/workboard
    args:
      - mcp
    env:
      WORKBOARD_DATA_DIR: !!js process.env.WORKBOARD_DATA_DIR || '/home/bahman/.local/share/workboard'
```

The child keeps protocol on stdout and the banner on stderr (verified with a
raw `initialize`/`tools/list` exchange). `WORKBOARD_DATA_DIR` (or `--dir`) selects
a throwaway board for development runs. Both presets registered serverName
`workboard`; only compose one of them per session (see trouble­shooting).

## 6. Token rotation / revocation

- Rotation: overwrite `~/.config/workboard/workboard.env`, replace the value
  in correspondence with the Workboard CLI, `daemon-reload && restart dsh`.
  A wrong token makes every MCP call fail closed: the agent sees
  Streamable HTTP error `UNAUTHENTICATED` and should stop touching the board.
- Revocation on the Workboard side takes effect immediately (token rows live
  in `workboard.sqlite`, `api_tokens.revoked_at`):
  `workboard --dir ~/.local/share/workboard token revoke --id <id>`.

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `UNAUTHENTICATED` on every MCP call | token in the Host env is wrong/revoked — re-rotate then restart `dsh`. |
| MCP calls fail with connection refused | `workboard` server down — `systemctl --user start workboard`; the bridge retries per request on HTTP. |
| Preset row missing in chip | preset files unparseable — roster marks `standing` FAIL; fix YAML until `standingKeyFor` passes. |
| `serverName` collision error at mount | two mcp-client rows in one session with the same name; compose only one variant. |
| Preset change not applied to a session | sessions pin the preset at creation — start a new session. |
| Credentials fixed but a session still fails | the bridge mounts per session against the env at Host start — start a new session. |

## 8. Rollback

Presets live only under `~/.dsh/.agent-presets/`: `rm -rf` the preset
directory (the roster drops the row on the next `agentPreset.list`). Remove
`dsh.service.d/workboard.conf` + `daemon-reload && restart dsh` to drop the
token from the Host. `systemctl --user disable --now workboard` stops the
server; board state lives in `~/.local/share/workboard` and is untouched by all of
these steps.
