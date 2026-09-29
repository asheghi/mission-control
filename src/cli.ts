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
import type { EventPublisher } from "./app/events";
import { authenticate, issueToken } from "./auth/service";
import { initializeDatabase } from "./db/database";
import {
  claimRestoreLock,
  claimServePid,
  findRestoreHolder,
  PID_LOCK_ERROR,
  PID_LOCK_STALE,
  releaseRestoreLock,
  releaseServePid,
  restoreLockPath,
  servePidFilePath,
} from "./maintenance/serve-lock";
import type { Database } from "bun:sqlite";
import { createApiHandler } from "./api/app";
import {
  BLOB_BACKENDS,
  configFromFlags,
  effectiveStorageConfig,
  readStorageConfig,
  resolveBlobStore,
  sameBlobLocation,
  storageConfigPath,
  writeStorageConfig,
} from "./storage/config";
import type { BlobStore } from "./storage/types";
import { handleMcpRequest } from "./api/mcp-http";
import { runStdioMcpServer } from "./mcp/stdio";
import { APP_VERSION } from "./version";
import { backupDatabase, defaultBackupPath, preflightRestore, restoreDatabase, runDoctor as doctorChecks, doctorAttachmentChecks } from "./maintenance/backup";
import { bundleDatabasePath, createBundle, defaultBundlePath, restoreBundleBlobs } from "./maintenance/bundle";
import { mkdirSync, statSync } from "node:fs";
import { seedBoard } from "./dev/seed";
import { STATIC_ASSETS } from "./web/static-assets";
import { boundedDiagnostic } from "./observability/diagnostic";

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
  return value(args, "dir") ?? value(args, "data") ?? process.env.WORKBOARD_DATA_DIR ?? join(process.cwd(), "workboard-data");
}

function openInitializedDb(ctx: CommandContext): Database {
  // initializeDatabase is idempotent: it applies pending migrations, which is
  // required because commands may run before an explicit `workboard init`.
  return initializeDatabase(ctx.dataDir);
}


/**
 * Build a service bound to this board's configured blob storage.
 *
 * Every command goes through here so `serve`, `doctor`, `backup`, and one-off
 * edits cannot disagree about where attachments live. A board with no explicit
 * configuration resolves to the filesystem default beside the database.
 */
function openServiceWithStorage(
  db: Database,
  ctx: CommandContext,
  extras: { events?: EventPublisher } = {},
): { service: WorkboardService; store: BlobStore } {
  const { store } = resolveBlobStore({ dataDir: ctx.dataDir });
  const service = new WorkboardService(db, systemClock, extras.events, { blobs: store });
  return { service, store };
}

/** The storage flags `init` accepts, parsed once. */
const STORAGE_FLAGS = new Set(["blob-backend", "blob-dir", "blob-bucket", "blob-endpoint", "blob-region", "blob-prefix"]);

function storageFlagsFrom(args: ParsedArgs): Parameters<typeof configFromFlags>[1] {
  return {
    ...(value(args, "blob-backend") !== undefined ? { backend: value(args, "blob-backend") as string } : {}),
    ...(value(args, "blob-dir") !== undefined ? { directory: value(args, "blob-dir") as string } : {}),
    ...(value(args, "blob-bucket") !== undefined ? { bucket: value(args, "blob-bucket") as string } : {}),
    ...(value(args, "blob-endpoint") !== undefined ? { endpoint: value(args, "blob-endpoint") as string } : {}),
    ...(value(args, "blob-region") !== undefined ? { region: value(args, "blob-region") as string } : {}),
    ...(value(args, "blob-prefix") !== undefined ? { prefix: value(args, "blob-prefix") as string } : {}),
  };
}

/** How many attachments currently depend on the configured storage. */
function countCommittedAttachments(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS n FROM attachments WHERE state = 'committed'").get() as { n: number } | null;
  return row?.n ?? 0;
}

/** A one-line, credential-free description of where attachments will live. */
function describeStorage(config: { backend: string; directory?: string; bucket?: string; endpoint?: string; prefix?: string }): string {
  if (config.backend === "s3") {
    const where = config.endpoint !== undefined ? `${config.bucket} at ${config.endpoint}` : String(config.bucket);
    return `s3 (${where}${config.prefix !== undefined ? `, prefix ${config.prefix}` : ""})`;
  }
  return `filesystem (${config.directory ?? "blobs"})`;
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

function runInit(ctx: CommandContext, rest: readonly string[]): number {
  const args = parseArgs(rest, new Set(["admin", ...STORAGE_FLAGS]));
  const db = initializeDatabase(ctx.dataDir);
  try {
    // Storage is chosen here, once, and remembered for every later command.
    // Only the flags actually given are applied, so re-running init to change
    // one setting never discards the others; with no flags at all, an existing
    // configuration is left exactly as it is.
    const existing = readStorageConfig(ctx.dataDir);
    const hasStorageFlags = [...STORAGE_FLAGS].some((name) => value(args, name) !== undefined);
    const storage = configFromFlags(ctx.dataDir, storageFlagsFrom(args), existing);
    // Moving the blob location strands every existing attachment: the rows keep
    // their keys, but the new backend has none of the objects. Refusing to do it
    // silently is the difference between a config change and data loss.
    //
    // The comparison is against the location the board is *effectively* using,
    // not against the config file: a board with no file is on the filesystem
    // default, and moving it away from there strands blobs just the same.
    const effective = effectiveStorageConfig(ctx.dataDir);
    if (!sameBlobLocation(effective, storage)) {
      const attachments = countCommittedAttachments(db);
      if (attachments > 0 && !flag(args, "force")) {
        fail(
          `refusing to change attachment storage from ${describeStorage(effective)} to ${describeStorage(storage)}: ` +
            `${attachments} attachment(s) still live in the current location. ` +
            "Copy them across first, or pass --force to accept that they become unreachable.",
        );
      }
    }
    if (existing !== null || hasStorageFlags) writeStorageConfig(ctx.dataDir, storage);
    const service = new WorkboardService(db, systemClock, undefined, {
      blobs: resolveBlobStore({ dataDir: ctx.dataDir, config: storage }).store,
    });
    const firstInit = service.listParticipants(LOCAL_ACTOR_BOOTSTRAP).length === 0;
    const adminName = value(args, "admin") === "" ? "admin" : value(args, "admin") ?? "admin";
    let bootstrapToken: string | undefined;
    if (firstInit) {
      const admin = service.createParticipant(LOCAL_ACTOR_BOOTSTRAP, { name: adminName, kind: "human" });
      // The bootstrap token always exists (it is the only credential the init
      // output could ever print again — plaintext is never persisted, the DB
      // stores a hash). --hide-token only suppresses the printing.
      bootstrapToken = issueToken(db, { participantId: admin.id, name: "bootstrap", now: systemClock.now() }).plaintext;
      if (flag(args, "hide-token")) bootstrapToken = undefined;
    }
    const storageSummary = describeStorage(storage);
    const message = `Initialized workboard at ${ctx.dataDir}`;
    if (flag(ctx.globalArgs, "json")) {
      printJson({
        dataDir: ctx.dataDir,
        initialized: true,
        storage: { ...storage },
        ...(bootstrapToken ? { token: bootstrapToken } : {}),
      });
    } else {
      console.log(message);
      console.log(`Attachments: ${storageSummary}`);
      if (bootstrapToken !== undefined) {
        console.error("Store this token now; it is not shown again.");
        console.log(bootstrapToken);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

function runAdd(ctx: CommandContext, rest: readonly string[]): number {
  const args = parseArgs(rest, new Set(["body", "priority", "labels", "assignee", "type", "parent"]));
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
      ...(value(args, "type") !== undefined ? { type: value(args, "type") } : {}),
      ...(value(args, "parent") !== undefined ? { parentId: Number(value(args, "parent")) } : {}),
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
  const args = parseArgs(rest, new Set(["status", "type", "assignee", "label", "q", "limit", "cursor"]));
  const db = openInitializedDb(ctx);
  try {
    const service = new WorkboardService(db);
    const actor = resolveActor(service, ctx.globalArgs);
    const raw: RawItemQuery = {
      ...(value(args, "status") !== undefined ? { status: value(args, "status") } : {}),
      ...(value(args, "type") !== undefined ? { type: value(args, "type") } : {}),
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
        const labels = item.labels.length > 0 ? ` [${item.labels.map((label) => label.name).join(", ")}]` : "";
        console.log(`#${item.id} [${item.type}] [${item.status}] (P${item.priority}) ${item.title}${assignee}${labels}`);
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
    console.log(`#${item.id} [${item.type}] [${item.status}] (P${item.priority}) ${item.title}`);
    if (item.body.length > 0) console.log(item.body);
    const meta: string[] = [];
    if (item.assignee !== null) meta.push(`assignee: @${item.assignee.name}`);
    if (item.labels.length > 0) meta.push(`labels: ${item.labels.map((label) => label.name).join(", ")}`);
    meta.push(`created by #${item.createdBy}`);
    if (item.closedAt !== null) meta.push(`closed: ${item.closedAt}`);
    if (meta.length > 0) console.log(meta.join(" | "));
    if (detail.parent !== null) console.log(`  parent: #${detail.parent.id} ${detail.parent.title}`);
    for (const child of detail.children) console.log(`  child: #${child.id} ${child.title}`);
    for (const relation of [
      ...detail.related,
      ...detail.predecessors,
      ...detail.successors,
      ...detail.duplicates,
      ...(detail.duplicateOf === null ? [] : [detail.duplicateOf]),
    ]) console.log(`  ${relation.name}: #${relation.item.id} ${relation.item.title} (relationship #${relation.id})`);
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
  const args = parseArgs(rest, new Set(["title", "body", "status", "priority", "assignee", "labels", "type", "parent"]));
  const id = Number(args.positionals[0]);
  if (!Number.isInteger(id) || id <= 0) fail("an item id is required: workboard update <id> [fields]");
  const patch: Record<string, unknown> = {};
  if (value(args, "title") !== undefined) patch.title = value(args, "title");
  if (value(args, "body") !== undefined) patch.body = value(args, "body");
  if (value(args, "status") !== undefined) patch.status = value(args, "status");
  if (value(args, "priority") !== undefined) patch.priority = Number(value(args, "priority"));
  if (value(args, "type") !== undefined) patch.type = value(args, "type");
  if (value(args, "parent") !== undefined) patch.parentId = Number(value(args, "parent"));
  if (flag(args, "detach")) patch.parentId = null;
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

function runRelationship(ctx: CommandContext, rest: readonly string[]): number {
  const args = parseArgs(rest, new Set());
  const action = args.positionals[0];
  const itemId = Number(args.positionals[1]);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) fail("relationship requires an item id");
  const db = openInitializedDb(ctx);
  try {
    const service = new WorkboardService(db);
    const actor = resolveActor(service, ctx.globalArgs);
    if (action === "add") {
      const name = args.positionals[2];
      const targetId = Number(args.positionals[3]);
      if (name === undefined || !Number.isSafeInteger(targetId) || targetId <= 0) {
        fail("usage: workboard relationship add <id> <name> <target-id>");
      }
      const result = service.createRelationship(actor, itemId, { name, itemId: targetId });
      if (flag(ctx.globalArgs, "json")) printJson(result);
      else console.log(`Added ${name} relationship from #${itemId} to #${targetId}`);
      return 0;
    }
    if (action === "remove") {
      const relationshipId = Number(args.positionals[2]);
      if (!Number.isSafeInteger(relationshipId) || relationshipId <= 0) {
        fail("usage: workboard relationship remove <id> <relationship-id>");
      }
      const result = service.deleteRelationship(actor, itemId, { relationshipId });
      if (flag(ctx.globalArgs, "json")) printJson(result);
      else console.log(`Removed relationship #${relationshipId} from item #${itemId}`);
      return 0;
    }
    if (action === "list") {
      const detail = service.getItem(actor, itemId);
      const relationships = {
        parent: detail.parent,
        children: detail.children,
        related: detail.related,
        predecessors: detail.predecessors,
        successors: detail.successors,
        duplicates: detail.duplicates,
        duplicateOf: detail.duplicateOf,
      };
      if (flag(ctx.globalArgs, "json")) printJson(relationships);
      else for (const [name, value] of Object.entries(relationships)) {
        const count = value === null ? 0 : Array.isArray(value) ? value.length : 1;
        console.log(`${name}: ${count}`);
      }
      return 0;
    }
    fail("relationship action must be add, remove, or list");
  } finally {
    db.close();
  }
}

function runReorder(ctx: CommandContext, rest: readonly string[]): number {
  const args = parseArgs(rest, new Set(["parent", "before"]));
  const itemId = Number(args.positionals[0]);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) fail("reorder requires an item id");
  const parentRaw = value(args, "parent");
  if (parentRaw === undefined) fail("--parent <id|root> is required");
  const parentId = parentRaw === "root" ? null : Number(parentRaw);
  if (parentId !== null && (!Number.isSafeInteger(parentId) || parentId <= 0)) fail("invalid parent id");
  const beforeRaw = value(args, "before");
  const beforeId = beforeRaw === undefined || beforeRaw === "end" ? null : Number(beforeRaw);
  if (beforeId !== null && (!Number.isSafeInteger(beforeId) || beforeId <= 0)) fail("invalid before id");
  const db = openInitializedDb(ctx);
  try {
    const service = new WorkboardService(db);
    const actor = resolveActor(service, ctx.globalArgs);
    const result = service.reorderItem(actor, itemId, { parentId, beforeId });
    if (flag(ctx.globalArgs, "json")) printJson(result);
    else console.log(`Moved item #${itemId} to position ${result.backlogPosition}`);
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
    // The stdio server exposes the same tools as HTTP, so it needs the same
    // blob storage; without it every attachment tool would fail with "no
    // attachment storage is configured".
    const { store } = resolveBlobStore({ dataDir: ctx.dataDir });
    const service = new WorkboardService(db, systemClock, undefined, { blobs: store });
    const actor = resolveLocalActor(service, actorName);
    await runStdioMcpServer(service, actor);
    return 0;
  } finally {
    db.close();
  }
}

async function runServeCommand(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const args = parseArgs(rest, new Set(["host", "port", "token"]));
  const host = value(args, "host") ?? "127.0.0.1";
  const portRaw = value(args, "port") ?? process.env.WORKBOARD_PORT ?? "8765";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) fail(`invalid port: ${portRaw}`);

  // A restore replaces the database and the attachment bytes. Starting a server
  // into that window would read a half-swapped board, so it is refused while a
  // restore holds the directory. The check is repeated after claiming the serve
  // PID: without that handshake a restore could acquire its lock between this
  // first check and our claim, and both operations would proceed.
  mkdirSync(ctx.dataDir, { recursive: true });
  const restoring = findRestoreHolder(ctx.dataDir);
  if (restoring !== null) {
    fail(`a restore (pid ${restoring}) is replacing ${ctx.dataDir}; wait for it to finish before serving`);
  }

  const otherServe = claimServePid(ctx.dataDir, process.pid);
  if (otherServe !== null) {
    if (otherServe === PID_LOCK_ERROR) fail(`cannot lock ${ctx.dataDir} for serving`);
    if (otherServe === PID_LOCK_STALE) {
      fail(`stale serve lock at ${servePidFilePath(ctx.dataDir)}; remove it after confirming no server uses this board`);
    }
    fail(`another serve (pid ${otherServe}) is already using ${ctx.dataDir}`);
  }
  const racedRestore = findRestoreHolder(ctx.dataDir);
  if (racedRestore !== null) {
    releaseServePid(ctx.dataDir, process.pid);
    fail(`a restore (pid ${racedRestore}) is replacing ${ctx.dataDir}; wait for it to finish before serving`);
  }

  let db: Database;
  try {
    db = initializeDatabase(ctx.dataDir);
  } catch (error) {
    releaseServePid(ctx.dataDir, process.pid);
    throw error;
  }
  try {
    const clock: Clock = systemClock;
    const broker = new WorkboardEventBroker(clock);
    const { store: blobStore } = resolveBlobStore({ dataDir: ctx.dataDir });
    const service = new WorkboardService(db, clock, broker, { blobs: blobStore });
    // Startup maintenance, before anyone is served: interrupted uploads leave
    // `pending` rows, and any deletion queued by a previous run may still owe
    // bytes. The sweep drains only when it finds stale rows, so an explicit
    // drain runs too — a board whose last shutdown happened mid-cascade would
    // otherwise never work off its queue.
    void service
      .sweepPendingAttachments()
      .then(() => service.drainBlobDeletions())
      .catch(() => {});
    // The handler is built before Bun.serve returns, so hold the server in a
    // mutable binding: the SSE route calls back into it to exempt its streaming
    // response from the idle timeout that would otherwise end a live feed.
    let server: ReturnType<typeof Bun.serve> | undefined;
    const handler = createApiHandler({
      service,
      broker,
      authenticate: (credential, now) => authenticate(db, credential, now),
      clock,
      staticAssets: STATIC_ASSETS,
      disableIdleTimeout: (request) => server?.timeout(request, 0),
    });
    server = Bun.serve({ hostname: host, port, fetch: handler });
    // One write so the banner cannot be split across pipe chunks mid-line.
    const lines = [
      `workboard listening on http://${host}:${server.port}`,
      `  REST:  http://${host}:${server.port}/api/health`,
      `  MCP:   http://${host}:${server.port}/mcp`,
    ];
    // The link carries the token in a URL fragment: a fragment never reaches
    // the server, and the web client stores it and strips it from the address
    // bar immediately (see consumeTokenFromHash in src/web/api.js).
    //
    // With no --token/--hide-token, serve mints its own session credential for
    // the default human participant (admin, else the first human, else the
    // first participant) so the link opens a signed-in web UI with no extra
    // commands. It is revoked when this serve exits, so nothing lingers.
    let sessionTokenId: number | null = null;
    let tokenForLink = value(args, "token") ?? process.env.WORKBOARD_TOKEN;
    if (!flag(args, "hide-token") && (tokenForLink === undefined || tokenForLink === "")) {
      const participants = service.listParticipants(LOCAL_ACTOR_BOOTSTRAP);
      const lowered = "admin";
      const target =
        participants.find((participant) => participant.name.toLowerCase() === lowered && participant.kind === "human") ??
        participants.find((participant) => participant.kind === "human") ??
        participants[0];
      if (target !== undefined) {
        const issued = issueToken(db, { participantId: target.id, name: "serve-session", now: systemClock.now() });
        tokenForLink = issued.plaintext;
        sessionTokenId = issued.token.id;
      }
    }
    if (flag(args, "hide-token")) {
      lines.push(`  Web:   http://${host}:${server.port}/`);
    } else if (tokenForLink !== undefined && tokenForLink !== "") {
      lines.push(`  Web UI: http://${host}:${server.port}/#token=${tokenForLink}`);
    } else {
      lines.push(`  Web:   http://${host}:${server.port}/ (no participant to sign in as; run: workboard init)`);
    }
    console.error(lines.join("\n"));

    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        server.stop(true);
        if (sessionTokenId !== null) {
          db.run("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [systemClock.now(), sessionTokenId]);
        }
        resolve();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    return 0;
  } finally {
    releaseServePid(ctx.dataDir, process.pid);
    db.close();
  }
}

function runToken(ctx: CommandContext, rest: readonly string[]): number {
  const args = parseArgs(rest, new Set(["for", "participant", "name", "id"]));
  const subcommand = args.positionals[0];

  if (subcommand === "revoke") {
    const idRaw = value(args, "id");
    if (idRaw === undefined) fail("--id <token id> is required");
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) fail(`invalid token id: ${idRaw}`);
    const db = openInitializedDb(ctx);
    try {
      db.run("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [systemClock.now(), id]);
      const changed = (db.query("SELECT changes() AS n").get() as { n: number }).n;
      if (changed === 0) fail(`no active token with id ${id}`);
      if (flag(ctx.globalArgs, "json")) printJson({ revoked: id });
      else console.log(`Revoked token #${id}`);
      return 0;
    } finally {
      db.close();
    }
  }

  // `token create --participant NAME --name LABEL`; `token --for NAME` is the
  // Task 11 spelling and keeps working.
  const participantName = value(args, "participant") ?? value(args, "for");
  if (participantName === undefined) fail("--participant <name> is required (or --for <name>)");
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

function runParticipant(ctx: CommandContext, rest: readonly string[]): number {
  const args = parseArgs(rest, new Set(["name", "kind"]));
  const subcommand = args.positionals[0];
  const db = openInitializedDb(ctx);
  try {
    const service = new WorkboardService(db);
    const actor = resolveActor(service, ctx.globalArgs);
    if (subcommand === "add") {
      const name = value(args, "name");
      const kind = value(args, "kind") ?? "agent";
      if (name === undefined || name.length === 0) fail("--name <name> is required");
      if (kind !== "human" && kind !== "agent") fail(`--kind must be human or agent, got '${kind}'`);
      const created = service.createParticipant(actor, { name, kind });
      if (flag(ctx.globalArgs, "json")) printJson(created);
      else console.log(`Created participant #${created.id}: ${created.name} (${created.kind})`);
      return 0;
    }
    if (subcommand === "rename") {
      const current = args.positionals[1];
      const newName = value(args, "name");
      if (current === undefined || current.length === 0) fail("a participant is required: workboard participant rename <name> --name <new>");
      if (newName === undefined || newName.length === 0) fail("--name <new name> is required");
      const lowered = current.toLowerCase();
      const target = service.listParticipants(actor).find((participant) => participant.name.toLowerCase() === lowered);
      if (target === undefined) fail(`no participant named '${current}'`);
      try {
        const renamed = service.renameParticipant(actor, target.id, { name: newName });
        if (flag(ctx.globalArgs, "json")) printJson(renamed);
        else console.log(`Renamed participant #${renamed.id} to ${renamed.name}`);
      } catch (error) {
        if (error instanceof WorkboardError && error.code === "CONFLICT") {
          fail(`a participant named '${newName}' already exists`);
        }
        if (error instanceof WorkboardError && (error.code === "VALIDATION")) {
          fail(error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
      return 0;
    }
    // Default: list participants.
    const participants = service.listParticipants(actor);
    if (flag(ctx.globalArgs, "json")) printJson(participants);
    else for (const participant of participants) console.log(`#${participant.id} ${participant.name} (${participant.kind})`);
    return 0;
  } finally {
    db.close();
  }
}

function runSeed(ctx: CommandContext, rest: readonly string[]): number {
  const args = parseArgs(rest, new Set());
  const reset = flag(args, "reset");
  const db = openInitializedDb(ctx);
  try {
    const summary = seedBoard(db, { reset });
    if (flag(ctx.globalArgs, "json")) {
      printJson(summary);
    } else {
      console.log(`Seeded ${summary.totalItems} work item(s) in ${ctx.dataDir}`);
      console.log(
        `  ${summary.participants} participant(s), ${summary.labels} label(s), ` +
          `${summary.items} item(s), ${summary.comments} comment(s), ${summary.relationships} relationship(s)`,
      );
      if (summary.reset) console.log("  (existing work items were replaced)");
      console.log("");
      console.log("This is development data. Do not run it against a board you care about.");
    }
    return 0;
  } finally {
    db.close();
  }
}

async function runBackup(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  // `--database-only` is a boolean: listing it here would make the parser
  // consume the next token as its value, the convention every other flag follows.
  const args = parseArgs(rest, new Set(["output"]));
  const explicitOutput = value(args, "output");
  const databaseOnly = flag(args, "database-only");
  // What `--output` names decides the shape, so an existing call that asks for
  // `snap.db` keeps getting exactly that file. A bundle is a directory, and
  // silently turning a requested file into a directory would be a trap.
  const bundleOutput =
    explicitOutput === undefined
      ? defaultBundlePath(ctx.dataDir, new Date())
      : explicitOutput.endsWith(".db")
        ? null
        : explicitOutput;
  const output = bundleOutput ?? explicitOutput ?? defaultBundlePath(ctx.dataDir, new Date());
  const db = openInitializedDb(ctx);
  try {
    if (databaseOnly || bundleOutput === null) {
      // An explicit, clearly-labelled escape hatch: this really does omit the
      // attachment bytes, so it is never the default.
      backupDatabase(db, output);
      if (flag(ctx.globalArgs, "json")) printJson({ backup: output, attachments: "omitted" });
      else console.log(`Database-only backup written to ${output} (attachments omitted)`);
      return 0;
    }
    const { store } = resolveBlobStore({ dataDir: ctx.dataDir });
    const result = await createBundle({ dataDir: ctx.dataDir, db, blobs: store, outputPath: output, now: new Date() });
    if (flag(ctx.globalArgs, "json")) {
      printJson({ backup: result.path, attachmentCount: result.attachmentCount, totalBytes: result.totalBytes });
    } else {
      console.log(`Backup written to ${result.path}`);
      console.log(`  ${result.attachmentCount} attachment(s), ${result.totalBytes} byte(s) of media, plus the database`);
    }
    return 0;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    db.close();
  }
}

async function runRestore(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const args = parseArgs(rest, new Set(["input"]));
  const input = value(args, "input") ?? args.positionals[0];
  if (input === undefined) fail("--input <file> is required");

  // A directory is a backup bundle: its bytes go into storage before the
  // database is swapped. A plain file is a database snapshot from
  // `backup --database-only`.
  const isBundle = statSync(input, { throwIfNoEntry: false })?.isDirectory() === true;
  const databaseSource = isBundle ? bundleDatabasePath(input) : input;

  // Take the lock before preflight. `serve` performs the complementary
  // check/claim/recheck handshake, so either it publishes its PID first and this
  // preflight refuses, or this lock appears first and serve refuses. There is no
  // unprotected interval in which both can decide to proceed.
  mkdirSync(ctx.dataDir, { recursive: true });
  const restoreHolder = claimRestoreLock(ctx.dataDir);
  if (restoreHolder !== null) {
    if (restoreHolder === PID_LOCK_ERROR) fail(`cannot lock ${ctx.dataDir} for restore`);
    if (restoreHolder === PID_LOCK_STALE) {
      fail(`stale restore lock at ${restoreLockPath(ctx.dataDir)}; remove it after confirming no restore is running`);
    }
    fail(`another restore (pid ${restoreHolder}) is already replacing ${ctx.dataDir}`);
  }

  try {
    // Establish that this restore will actually be permitted BEFORE writing any
    // attachment bytes. Without this, a restore refused for a missing --force or
    // a live server would still have added or overwritten objects in storage.
    try {
      preflightRestore(ctx.dataDir, databaseSource, { force: flag(args, "force") });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }

    let restoredBlobs: { restored: number; skipped: number } | null = null;
    if (isBundle) {
      const { store } = resolveBlobStore({ dataDir: ctx.dataDir });
      try {
        restoredBlobs = await restoreBundleBlobs({ bundlePath: input, blobs: store });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }

    try {
      restoreDatabase(ctx.dataDir, databaseSource, { force: flag(args, "force") });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (flag(ctx.globalArgs, "json")) {
      printJson({ restored: true, dataDir: ctx.dataDir, ...(restoredBlobs ?? {}) });
    } else {
      console.log(`Restored ${input} into ${ctx.dataDir}`);
      if (restoredBlobs !== null) {
        console.log(`  ${restoredBlobs.restored} attachment blob(s) written, ${restoredBlobs.skipped} already present`);
      }
    }
    return 0;
  } finally {
    releaseRestoreLock(ctx.dataDir);
  }
}

async function runDoctorCommand(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const args = parseArgs(rest, new Set(["host", "port"]));
  const portRaw = value(args, "port") ?? "8765";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) fail(`invalid port: ${portRaw}`);
  const hostArg = value(args, "host");
  const { healthy, checks } = await doctorChecks(ctx.dataDir, {
    ...(hostArg !== undefined ? { host: hostArg } : {}),
    port,
  });
  // Attachment storage is checked against the configured backend, so a board
  // that stores media remotely reports on the place it actually uses.
  const { store } = resolveBlobStore({ dataDir: ctx.dataDir });
  const attachmentChecks = await doctorAttachmentChecks(ctx.dataDir, store);
  const allChecks = [...checks, ...attachmentChecks];
  for (const check of allChecks) {
    console.log(`${check.ok ? "[ok]" : "[FAIL]"} ${check.name}: ${check.detail}`);
  }
  const allHealthy = healthy && attachmentChecks.every((check) => check.ok);
  console.log(allHealthy ? "workboard: healthy" : "workboard: unhealthy");
  return allHealthy ? 0 : 1;
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
    const globalValueFlags = new Set(["--data", "--dir", "--as"]);
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
    const isGlobalValueFlag = (token: string | undefined): boolean => token === "--data" || token === "--dir" || token === "--as";
    const globalArgs = parseArgs(rest, new Set(["data", "dir", "as"]));
    const ctx: CommandContext = { globalArgs, dataDir: resolveDataDir(globalArgs) };
    const commandArgs = rest.filter((token, index) => {
      if (isGlobalValueFlag(token)) return false;
      const previous = rest[index - 1];
      return !isGlobalValueFlag(previous);
    });

    switch (command) {
      case "init":
        return runInit(ctx, commandArgs);
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
      case "relationship":
        return runRelationship(ctx, commandArgs);
      case "reorder":
        return runReorder(ctx, commandArgs);
      case "mcp":
        return await runMcpCommand(ctx);
      case "serve":
        return await runServeCommand(ctx, commandArgs);
      case "token":
        return runToken(ctx, commandArgs);
      case "participant":
        return runParticipant(ctx, commandArgs);
      case "backup":
        return await runBackup(ctx, commandArgs);
      case "seed":
        return runSeed(ctx, commandArgs);
      case "restore":
        return await runRestore(ctx, commandArgs);
      case "doctor":
        return await runDoctorCommand(ctx, commandArgs);
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
    // An unexpected failure is still a local operator's problem to fix, so the
    // class name and a bounded single-line message are recorded. Credentials and
    // item content are never collected into this diagnostic (see the helper).
    console.error(`workboard: unexpected error: ${boundedDiagnostic(error)}`);
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
      "  init [--admin <name>]      Create data dir, database, and the default human participant (default: admin); prints its access token once unless --hide-token",
      "  add <title> [options]       Create an item (--type --parent --body --priority --labels --assignee)",
      "  list [filters]              List items (--type --status --assignee --label --q --limit --cursor)",
      "  view <id>                   Show one item with relationships, comments, and history",
      "  update <id> [fields]        Patch fields (--type --parent --detach and existing fields)",
      "  comment <id> <text>         Comment on an item (@name mentions notify)",
      "  relationship <action> ...  Add, remove, or list item relationships",
      "  reorder <id> [options]      Move item (--parent <id|root> --before <id|end>)",
      "  serve [--host] [--port]     Run the HTTP server (REST + MCP); prints a sign-in link with a self-issued session token (unless --hide-token); --token uses your plaintext instead",
      "  participant add             Add a participant (--name <name> --kind human|agent); no args lists",
      "  participant rename <n>      Rename a participant (--name <new name>)",
      "  token create                Issue an API token (--participant <name> --name <label>)",
      "  token revoke                Revoke a token (--id <id>)",
      "  seed [--reset]              Fill an empty board with development data (--reset replaces existing work items)",
      "  backup                      Consistent snapshot (--output <file>)",
      "  restore                     Restore a backup (--input <file>, --force to overwrite)",
      "  doctor                      Health checks (data dir, integrity, schema, FKs, counts, port)",
      "  mcp                         Serve MCP over stdio",
      "",
      "Global options: --dir <path> (alias: --data)  --as <participant>  --json  --version",
    ].join("\n"),
  );
}
