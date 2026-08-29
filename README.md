# Agent Workboard

A local coordination broker for coding agents working concurrently on one Git
repository.

It assigns each task once, gives the claiming agent an isolated or explicitly
attached Git worktree, and records the branch and commit produced by Codex CLI,
Claude CLI, Hermes, or another harness.

> **Status: final planning baseline, not built.** `PLAN.md` defines the evidence
> gates and build order. The project stops before implementation if the baseline
> does not show a real coordination problem.

## What it fixes

When several coding agents work on one repository, they can:

- start the same task;
- mutate the same working directory;
- leave partial work that nobody can locate after a crash;
- finish without recording which branch or commit contains the result.

Agent Workboard coordinates those boundaries. It does not merge branches or
prevent Git merge conflicts.

## Core workflow

```text
ready -> claim -> provision/attach worktree -> work -> submit branch + HEAD
                                           \-> interrupt -> recover/resume
```

There are two workspace modes:

- **Managed:** the local adapter creates a dedicated branch and `git worktree`.
- **Attached:** an agent already inside a clean linked worktree registers it.

Git operations happen in the local CLI/MCP adapter. The central server cannot
create remote worktrees because repository paths are host-local.

Managed mode is enabled only for a harness integration that can bind subsequent
commands to the new path and prove that it did so. Otherwise the harness starts in
a prepared worktree and uses attached mode.

Attached mode rejects the repository's primary checkout so a claim cannot take
ownership of the shared working directory. Here, **clean** means
`git status --porcelain=v1 --untracked-files=all` is empty; staged, unstaged, and
untracked non-ignored files all count.

## Shape

```text
 browser ---------------------> workboard serve
                                  REST + events
                                  SQLite owner

 Codex / Claude / Hermes host
   workboard mcp or CLI -------> workboard serve
          |
          +-- local repository
          +-- isolated worktrees
```

One compiled executable provides the server, CLI, and MCP adapter:

```bash
./workboard serve --dir ./wb_data --port 8765
```

## Claim lifecycle

`claim_work` is one agent-facing operation:

1. reserve one `ready` item atomically;
2. create or validate a local worktree;
3. activate the claim with repository, host, branch, path, and base commit;
4. renew the lease automatically in the adapter;
5. submit a clean worktree's branch and head commit.

The LLM does not call `renew` itself.

If the adapter is killed, its lease eventually expires and the item becomes
`interrupted`, not `ready`. The worktree may contain valuable partial work. A
recovery command locates it and either resumes it or verifies that it is unchanged
before returning the item to the queue.

Repository-global stash changes and `prunable` worktree records require explicit
human recovery. No automatic operation deletes a branch, worktree, stash entry, or
Git worktree metadata.

## Guarantees

| Property | Mechanism |
|----------|-----------|
| One active claimant per item | Guarded SQLite `UPDATE ... RETURNING` |
| No shared managed working directory | Worktree per managed claim plus verified harness path adoption |
| Attached claim does not own shared checkout | Primary checkout rejected using Git-dir/common-dir identity |
| Untracked work is not called clean | Porcelain status includes all non-ignored untracked files |
| Lost claim response does not claim twice | Participant-scoped `request_id` replay |
| LLM does not manage heartbeats | Local adapter renews in the background |
| Crashed work remains discoverable | Expiry marks `interrupted`; workspace metadata persists |
| Submitted result is exact | Branch, base commit, and head commit are recorded |
| Stale human edits do not overwrite | Item revision plus `If-Match` |
| Markdown is not executable HTML | React rendering without raw HTML plus URL allowlist |

History attributes cooperating clients to their tokens. It is not tamper-proof
against an agent with the same operating-system access as the database owner.

## Statuses

```text
ready -> doing -> submitted
           |
           +-> interrupted -> resume or verified abandon
```

`submitted` means an agent produced a Git result. It does not mean that result is
reviewed or merged.

## Interfaces

- **MCP:** primary agent interface using the official MCP SDK over stdio.
- **CLI:** diagnostics and the same work operations for humans/scripts.
- **Web:** added only after measured dogfooding passes; shows queue, active
  workspaces, interruptions, submissions, and recovery warnings.

The MCP adapter exposes coarse operations such as `claim_work`, `submit_work`,
`release_work`, and `recover_work`. REST provisioning details remain internal.

## Deployment model

- one server process owns one SQLite database;
- one deployment coordinates one logical Git repository;
- local adapters may run on several hosts/clones;
- paths are host-local metadata, while repo/branch/commit identities are portable;
- Bun bundles the server, CLI, MCP SDK, and later web assets into one executable.

## Deliberately deferred

The first useful release has no themes, component playground, notifications,
dependency graph, hierarchy, multi-repository board, automatic merge, automatic
worktree deletion, or broad cross-platform service matrix.

Those features must be earned by a baseline and a controlled comparison on real
Codex, Claude, and Hermes work. See [PLAN.md](./PLAN.md).
