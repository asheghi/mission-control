# Agent Workboard

A simple backlog for a project where humans **and** AI agents do the work.

Add work items, assign them, comment on them, track them to done. The only
difference from any other tracker: an assignee or an @mention can be an agent,
and agents read and update the board through MCP instead of a browser.

## Participants

Everyone on the board is a participant with a `kind`:

| Kind | How they use it |
|------|-----------------|
| `human` | Web UI |
| `agent` | MCP tools (Codex, Claude Code, Hermes, …) |

Assignment, @mentions, comments, and history work identically for both. An agent
is not a special case in the data model — it is a row in `participants`.

## Work items

```
todo → doing → done
         └──→ blocked
```

Each item has a title, markdown body, status, priority, optional assignee, and
optional labels. Comments are threaded under the item.

## The loop

**Human:** creates an item, assigns it to `@claude`, writes what they want.

**Agent:** starts a session, calls `my_work` — gets everything assigned to it or
mentioning it. Picks one up, sets it to `doing`, does the work, comments with
what it did, sets it to `done`.

**Human:** sees it on the board, reads the comment, either closes it or reopens
with feedback.

Same loop either direction — an agent can file an item and @mention a human.

## Interfaces

- **Web** — board and list views, item detail, assign dropdown, comment box with
  @mention autocomplete. This is how humans use it.
- **MCP** — `list_work`, `my_work`, `get_work`, `create_work`, `update_work`,
  `comment`. This is how agents use it.
- **CLI** — the same operations for scripts and terminal humans.

## Deployment

One binary, one SQLite file.

```bash
./workboard serve --dir ./wb_data --port 8765
```

Bun compiles the server, web assets, CLI, and MCP adapter into a single
executable. Upgrading is replacing the binary.

## Documentation

Full usage guide — setup, CLI, web UI, MCP tools for agents, tokens, and
operations: **[docs/manual.md](docs/manual.md)**.

## Not doing

No sprints, epics, story points, workflows, custom fields, or permissions
matrix. No git integration — the agent's harness already owns the repo. If this
turns out to need those, they get added after it is being used, not before.
