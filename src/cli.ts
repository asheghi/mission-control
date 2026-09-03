// CLI (Task 11). Local commands open SQLite directly (decided default); the
// 'serve' command exposes REST + MCP over HTTP on the loopback interface.
// Human-readable output by default, machine-readable with --json.
import { join } from "node:path";
import { WorkboardError } from "./domain/errors";
import type { Actor, Clock } from "./domain/types";
import { systemClock } from "./domain/types";
import { resolveItemQuery } from "./app/item-query";
import type { RawItemQuery } from "./app/item-query";
import { resolveLocalActor, LOCAL_ACTOR_BOOTSTRAP } from "./app/local-actor";
import { WorkboardService } from "./app/workboard";
import { WorkboardEventBroker } from "./app/events";
import { authenticate, issueToken } from "./auth/service";
import { initializeDatabase } from "./db/database";
import type { Database } from "bun:sqlite";
import { createApiHandler } from "./api/app";
import type { StaticAsset } from "./api/app";
import { handleMcpRequest } from "./api/mcp-http";
import { runStdioMcpServer } from "./mcp/stdio";
import { APP_VERSION } from "./version";
import indexHtml from "./web/index.html" with { type: "text" };
import stylesCss from "./web/styles.css" with { type: "text" };
import appJs from "./web/app.js" with { type: "text" };
import apiJs from "./web/api.js" with { type: "text" };
import viewsJs from "./web/views.js" with { type: "text" };
import boardJs from "./web/board.js" with { type: "text" };
import listJs from "./web/list.js" with { type: "text" };

const STATIC_ASSETS: Record<string, StaticAsset> = {
  "/": { body: indexHtml, contentType: "text/html; charset=utf-8" },
  "/index.html": { body: indexHtml, contentType: "text/html; charset=utf-8" },
  "/assets/styles.css": { body: stylesCss, contentType: "text/css; charset=utf-8" },
  "/assets/app.js": { body: appJs, contentType: "text/javascript; charset=utf-8" },
  "/assets/api.js": { body: apiJs, contentType: "text/javascript; charset=utf-8" },
  "/assets/views.js": { body: viewsJs, contentType: "text/javascript; charset=utf-8" },
  "/assets/board.js": { body: boardJs, contentType: "text/javascript; charset=utf-8" },
  "/assets/list.js": { body: listJs, contentType: "text/javascript; charset=utf-8" },
};

interface ParsedArgs {
  readonly flags: Map<string, string | boolean>;
  readonly positionals: string[];
}

function parseArgs(argv: readonly string[], valueFlags: ReadonlySet<string>): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== undefined && token.startsWith("--")) {
      const name = token.slice(2);
      if (valueFlags.has(name)) {
        const value = argv[index + 1];
        flags.set(name, value ?? "");
        index += 1;
      } else {
        flags.set(name, true);
      }
    } else if (token !== undefined) {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

function value(args: ParsedArgs, name: string): string | undefined {
  const raw = args.flags.get(name);
  return typeof raw === "string" ? raw : undefined;
}

function flag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

function fail(message: string): never {
  console.error(`workboard: ${message}`);
  throw new CliExit(1);
}

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

interface CommandContext {
  readonly globalArgs: ParsedArgs;
  readonly dataDir: string;
}

function resolveDataDir(args: ParsedArgs): string {
  return value(args, "data") ?? process.env.WORKBOARD_DATA_DIR ?? join(process.cwd(), "workboard-data");
}

function openInitializedDb(ctx: CommandContext): Database {
  // initializeDatabase is idempotent: it applies pending migrations, which is
  // required because commands may run before an explicit `workboard init`.
  return initializeDatabase(ctx.dataDir);
}

function resolveActor(service: WorkboardService, args: ParsedArgs): Actor {
  const name = value(args, "as") ?? process.env.WORKBOARD_USER ?? "local";
  return resolveLocalActor(service, name);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Commands

function runInit(ctx: CommandContext): number {
  const db = initializeDatabase(ctx.dataDir);
  try {
    const service = new WorkboardService(db);
    const existing = service.listParticipants(LOCAL_ACTOR_BOOTSTRAP);
    if (existing.length === 0) {
      service.createParticipant(LOCAL_ACTOR_BOOTSTRAP, { name: "local", kind: "human" });
    }
    const message = `Initialized workboard at ${ctx.dataDir}`;
    if (flag(ctx.globalArgs, "json")) printJson({ dataDir: ctx.dataDir, initialized: true });
    else console.log(message);
    return 0;
  } finally {
    db.close();
  }
}

function runAdd(ctx: CommandContext, rest: readonly string[]): number {
  const args = parseArgs(rest, new Set(["body", "priority", "labels", "assignee"]));
  const title = args.positionals[0];
  if (title === undefined || title.length === 0) fail("a title is required: workboard add <title>");

  const db = openInitializedDb(ctx);
  try {
    const service = new WorkboardService(db);
    const actor = resolveActor(service, ctx.globalArgs);
    const labelsRaw = value(args, "labels");
    const detail = service.createItem(actor, {
      title,
      ...(value(args, "body") !== undefined ? { body: value(args, "body") } : {}),
      ...(value(args, "priority") !== undefined ? { priority: Number(value(args, "priority")) } : {}),
      ...(value(args, "assignee") !== undefined ? { assigneeId: resolveAssigneeArg(service, actor, value(args, "assignee")) } : {}),
      ...(labelsRaw !== undefined ? { labels: ensureLabels(service, actor, labelsRaw) } : {}),
    });
    if (flag(ctx.globalArgs, "json")) printJson(detail);
    else console.log(`Created item #${detail.item.id}: ${detail.item.title}`);
    return 0;
  } finally {
    db.close();
  }
}

// CLI convenience: `--labels a,b` creates missing labels locally (the API
// itself requires labels to exist first).
const LABEL_PALETTE = ["#3B82F6", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899"] as const;

function ensureLabels(service: WorkboardService, actor: Actor, raw: string): string[] {
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const existing = new Set(service.listLabels(actor).map((label) => label.name.toLowerCase()));
  for (const name of names) {
    if (!existing.has(name.toLowerCase())) {
      const color = LABEL_PALETTE[name.length % LABEL_PALETTE.length] ?? "#6B7280";
      service.createLabel(actor, { name, color });
    }
  }
  return names;
}

function resolveAssigneeArg(service: WorkboardService, actor: Actor, raw: string | undefined): number | null {
  if (raw === undefined || raw === "unassigned") return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const lowered = raw.toLowerCase();
  const match = service.listParticipants(actor).find((participant) => participant.name.toLowerCase() === lowered);
  if (match === undefined) fail(`no participant named '${raw}'`);
  return match.id;
}

function runList(ctx: CommandContext, rest: readonly string[]): number {
  const args = parseArgs(rest, new Set(["status", "assignee", "label", "q", "limit", "cursor"]));
  const db = openInitializedDb(ctx);
  try {
    const service = new WorkboardService(db);
    const actor = resolveActor(service, ctx.globalArgs);
    const raw: RawItemQuery = {
      ...(value(args, "status") !== undefined ? { status: value(args, "status") } : {}),
      ...(value(args, "assignee") !== undefined ? { assignee: value(args, "assignee") } : {}),
      ...(value(args, "label") !== undefined ? { label: value(args, "label") } : {}),
      ...(value(args, "q") !== undefined ? { q: value(args, "q") } : {}),
      ...(value(args, "limit") !== undefined ? { limit: Number(value(args, "limit")) } : {}),
      ...(value(args, "cursor") !== undefined ? { cursor: value(args, "cursor") } : {}),
    };
    const { filter, emptyResult } = resolveItemQuery(service, actor, raw);
    const result = emptyResult ? { items: [], nextCursor: null as string | null } : service.listItems(actor, filter);
    if (flag(ctx.globalArgs, "json")) {
      printJson({ items: result.items, nextCursor: result.nextCursor });
    } else {
      for (const item of result.items) {
        const assignee = item.assignee === null ? "" : ` @${item.assignee.name}`;
        const labels = item.labels.length > 0 ? ` [${item.labels.join(", ")}]` : "";
        console.log(`#${item.id} [${item.status}] (P${item.priority}) ${item.title}${assignee}${labels}`);
      }
      if (result.nextCursor !== null) {
        console.log(`— next page: --cursor ${result.nextCursor}`);
      }
      console.log(`(${result.items.length} item(s))`);
    }
    return 0;
  } finally {
    db.close();
  }
}

function runView(ctx: CommandContext, rest: readonly string[]): number {
  const args = parseArgs(rest, new Set());
  const idRaw = args.positionals[0];
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) fail("an item id is required: workboard view <id>");
  const db = openInitializedDb(ctx);
  try {
    const service = new WorkboardService(db);
    const actor = resolveActor(service, ctx.globalArgs);
    const detail = service.getItem(actor, id);
    if (flag(ctx.globalArgs, "json")) {
      printJson(detail);
      return 0;
    }
    const item = detail.item;
    console.log(`#${item.id} [${item.status}] (P${item.priority}) ${item.title}`);
    if (item.body.length > 0) console.log(item.body);
    const meta: string[] = [];
    if (item.assignee !== null) meta.push(`assignee: @${item.assignee.name}`);
    if (item.labels.length > 0) meta.push(`labels: ${item.labels.join(", ")}`);
    meta.push(`created by #${item.createdBy}`);
    if (item.closedAt !== null) meta.push(`closed: ${item.closedAt}`);
    if (meta.length > 0) console.log(meta.join(" | "));
    for (const comment of detail.comments) {
      console.log(`  > @${comment.author.name}: ${comment.body}`);
    }
    for (const entry of detail.history) {
      const change =
        entry.oldValue === null && entry.newValue === null
          ? entry.field
          : `${entry.field}: ${entry.oldValue ?? "∅"} → ${entry.newValue ?? "∅"}`;
      console.log(`  * ${change} (by @${entry.actorName})`);
    }
    return 0;
  } finally {
    db.close();
  }
}

function runUpdate(ctx: CommandContext, rest: readonly string[]): number {
  const args = parseArgs(rest, new Set(["title", "body", "status", "priority", "assignee", "labels"]));
  const id = Number(args.positionals[0]);
  if (!Number.isInteger(id) || id <= 0) fail("an item id is required: workboard update <id> [fields]");
  const patch: Record<string, unknown> = {};
  if (value(args, "title") !== undefined) patch.title = value(args, "title");
  if (value(args, "body") !== undefined) patch.body = value(args, "body");
  if (value(args, "status") !== undefined) patch.status = value(args, "status");
  if (value(args, "priority") !== undefined) patch.priority = Number(value(args, "priority"));
  if (flag(args, "unassign")) patch.assigneeId = null;
  else if (value(args, "assignee") !== undefined) {
    const db = openInitializedDb(ctx);
    try {
      const service = new WorkboardService(db);
      const actor = resolveActor(service, ctx.globalArgs);
      patch.assigneeId = resolveAssigneeArg(service, actor, value(args, "assignee"));
    } finally {
      db.close();
    }
  }
  if (value(args, "labels") !== undefined) {
    const db2 = openInitializedDb(ctx);
    try {
      const service2 = new WorkboardService(db2);
      const actor2 = resolveActor(service2, ctx.globalArgs);
      patch.labels = ensureLabels(service2, actor2, value(args, "labels") as string);
    } finally {
      db2.close();
    }
  }

  const db = openInitializedDb(ctx);
  try {
    const service = new WorkboardService(db);
    const actor = resolveActor(service, ctx.globalArgs);
    const result = service.updateItem(actor, id, patch);
    if (flag(ctx.globalArgs, "json")) printJson(result);
    else if (result.changedFields.length === 0) console.log(`No changes for item #${id}`);
    else console.log(`Updated item #${id} (changed: ${result.changedFields.join(", ")})`);
    return 0;
  } finally {
    db.close();
  }
}

function runComment(ctx: CommandContext, rest: readonly string[]): number {
  const args = parseArgs(rest, new Set());
  const id = Number(args.positionals[0]);
  const body = args.positionals.slice(1).join(" ").trim();
  if (!Number.isInteger(id) || id <= 0) fail("an item id is required: workboard comment <id> <text>");
  if (body.length === 0) fail("comment text is required");
  const db = openInitializedDb(ctx);
  try {
    const service = new WorkboardService(db);
    const actor = resolveActor(service, ctx.globalArgs);
    const result = service.addComment(actor, id, { body });
    if (flag(ctx.globalArgs, "json")) printJson(result);
    else {
      const mentioned = result.mentionedParticipants.map((participant) => `@${participant.name}`).join(", ");
      console.log(`Comment added to item #${id}${mentioned.length > 0 ? ` (mentioned: ${mentioned})` : ""}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

async function runMcpCommand(ctx: CommandContext): Promise<number> {
  const actorName = value(ctx.globalArgs, "as") ?? process.env.WORKBOARD_USER ?? "local";
  if (value(ctx.globalArgs, "as") === undefined && process.env.WORKBOARD_USER === undefined) {
    // Keep stdio clean: chatter belongs on stderr, never stdout (JSON-RPC).
    console.error("[workboard] no --as given; attributing work to 'local'");
  }
  const db = openInitializedDb(ctx);
  try {
    const service = new WorkboardService(db);
    const actor = resolveLocalActor(service, actorName);
    await runStdioMcpServer(service, actor);
    return 0;
  } finally {
    db.close();
  }
}

async function runServeCommand(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const args = parseArgs(rest, new Set(["host", "port"]));
  const host = value(args, "host") ?? "127.0.0.1";
  const portRaw = value(args, "port") ?? process.env.WORKBOARD_PORT ?? "8765";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) fail(`invalid port: ${portRaw}`);

  const db = initializeDatabase(ctx.dataDir);
  try {
    const clock: Clock = systemClock;
    const broker = new WorkboardEventBroker(clock);
    const service = new WorkboardService(db, clock, broker);
    const handler = createApiHandler({
      service,
      broker,
      authenticate: (credential, now) => authenticate(db, credential, now),
      clock,
      staticAssets: STATIC_ASSETS,
    });
    const server = Bun.serve({ hostname: host, port, fetch: handler });
    console.error(`workboard listening on http://${host}:${server.port}`);
    console.error(`  REST:  http://${host}:${server.port}/api/health`);
    console.error(`  MCP:   http://${host}:${server.port}/mcp`);

    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        server.stop(true);
        resolve();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    return 0;
  } finally {
    db.close();
  }
}

function runToken(ctx: CommandContext, rest: readonly string[]): number {
  const args = parseArgs(rest, new Set(["for", "name"]));
  const participantName = value(args, "for");
  if (participantName === undefined) fail("--for <participant> is required");
  const db = openInitializedDb(ctx);
  try {
    const service = new WorkboardService(db);
    const actor = resolveActor(service, ctx.globalArgs);
    const lowered = participantName.toLowerCase();
    const target = service.listParticipants(actor).find((participant) => participant.name.toLowerCase() === lowered);
    if (target === undefined) fail(`no participant named '${participantName}'`);
    const label = value(args, "name") ?? "cli-issued";
    const issued = issueToken(db, {
      participantId: target.id,
      name: label,
      now: systemClock.now(),
    });
    if (flag(ctx.globalArgs, "json")) {
      printJson({ token: issued.plaintext, participant: target.name, tokenName: label, createdAt: issued.token.created_at });
    } else {
      console.error("Store this token now; it is not shown again.");
      console.log(issued.plaintext);
    }
    return 0;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Entry

export async function runCli(argv: readonly string[]): Promise<number> {
  try {
    if (argv.includes("--version") || argv.includes("-v")) {
      console.log(APP_VERSION);
      return 0;
    }

    // Global flags may appear before the command; skip them (and their values)
    // to find the command token.
    const globalValueFlags = new Set(["--data", "--as"]);
    let commandIndex = 0;
    while (commandIndex < argv.length) {
      const token = argv[commandIndex];
      if (token === "--json") {
        commandIndex += 1;
        continue;
      }
      if (token !== undefined && globalValueFlags.has(token)) {
        commandIndex += 2;
        continue;
      }
      break;
    }
    const command = argv[commandIndex];
    const rest =
      command === undefined
        ? [...argv]
        : [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)];

    // Global flags may appear anywhere; carve them out for the shared context.
    const globalArgs = parseArgs(rest, new Set(["data", "as"]));
    const ctx: CommandContext = { globalArgs, dataDir: resolveDataDir(globalArgs) };
    const commandArgs = rest.filter((token, index) => {
      if (token === "--data" || token === "--as") return false;
      const previous = rest[index - 1];
      return previous !== "--data" && previous !== "--as";
    });

    switch (command) {
      case "init":
        return runInit(ctx);
      case "add":
        return runAdd(ctx, commandArgs);
      case "list":
        return runList(ctx, commandArgs);
      case "view":
        return runView(ctx, commandArgs);
      case "update":
        return runUpdate(ctx, commandArgs);
      case "comment":
        return runComment(ctx, commandArgs);
      case "mcp":
        return await runMcpCommand(ctx);
      case "serve":
        return await runServeCommand(ctx, commandArgs);
      case "token":
        return runToken(ctx, commandArgs);
      case "help":
      case "--help":
      case "-h":
      case undefined:
        printUsage();
        return command === undefined ? 1 : 0;
      default:
        printUsage();
        return 1;
    }
  } catch (error) {
    if (error instanceof CliExit) return error.code;
    if (error instanceof WorkboardError) {
      console.error(`workboard: ${error.message}`);
      return 1;
    }
    console.error(`workboard: unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function printUsage(): void {
  console.error(
    [
      `workboard ${APP_VERSION} — local-first work tracking`,
      "",
      "Usage: workboard <command> [options]",
      "",
      "Commands:",
      "  init                        Create the data directory and database",
      "  add <title> [options]       Create a work item (--body --priority --labels --assignee)",
      "  list [filters]              List items (--status --assignee --label --q --limit --cursor)",
      "  view <id>                   Show one item with comments and history",
      "  update <id> [fields]        Patch fields (--title --body --status --priority --assignee --unassign --labels)",
      "  comment <id> <text>         Comment on an item (@name mentions notify)",
      "  serve [--host] [--port]     Run the HTTP server (REST + MCP)",
      "  token --for <participant>   Issue an API token (printed once)",
      "  mcp                         Serve MCP over stdio",
      "",
      "Global options: --data <dir>  --as <participant>  --json  --version",
    ].join("\n"),
  );
}
