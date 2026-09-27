// Development seed.
//
// Fills an empty board with a fixed, realistic dataset so a developer — or a
// browser test — has something to look at on the first run instead of an empty
// state that hides half the UI. The dataset itself lives in `seed-data.ts`.
//
// Design decisions worth knowing before changing this file:
//
//   * It writes through `WorkboardService`, not through repositories. Every
//     invariant the product promises (a task has a parent, a label exists before
//     an item uses it, a status change stamps `closed_at`, history is recorded)
//     is enforced in that layer, so a seeded board is valid by construction
//     rather than by a second, drifting copy of the rules.
//
//   * It is deterministic. No clock, no randomness, no environment reads — the
//     only nondeterminism is the `created_at` the service stamps itself. Two
//     seeded boards hold the same items, in the same order, with the same keys.
//
//   * It refuses to touch a board that already has work unless `reset` is
//     passed. A mistaken `--dir` pointing at a real board must not silently
//     append demo items to it, and `--reset` makes that destructive intent
//     explicit.
//
//   * `--reset` clears the work-item graph only: items, comments, mentions,
//     labels on items, history, and links. Participants, labels, and API tokens
//     survive, so a reset does not sign everyone out of the development board.
import type { Database } from "bun:sqlite";
import { ConflictError, InternalError } from "../domain/errors";
import type { Actor, Priority, WorkItemType, WorkStatus } from "../domain/types";
import { WorkboardService } from "../app/workboard";
import { LOCAL_ACTOR_BOOTSTRAP } from "../app/local-actor";
import { SEED_DATASET } from "./seed-data";
import type { SeedDataset, SeedItem, SeedRelationship } from "./seed-data";

export interface SeedOptions {
  /** Delete the existing work-item graph first. Required for a non-empty board. */
  readonly reset?: boolean;
  /** Overrides the dataset. Used by tests to build a small board. */
  readonly dataset?: SeedDataset;
}

export interface SeedSummary {
  /** True when the existing work items were deleted first. */
  readonly reset: boolean;
  /** Rows created by this run; existing participants and labels are reused. */
  readonly participants: number;
  readonly labels: number;
  readonly items: number;
  readonly comments: number;
  readonly relationships: number;
  /** Work items on the board after seeding. */
  readonly totalItems: number;
  /** Ids by dataset key, so a caller (or a test) can address seeded items. */
  readonly itemIds: Readonly<Record<string, number>>;
}

/** How many work items the board currently holds. */
export function countItems(db: Database): number {
  const row = db.query("SELECT count(*) AS n FROM items").get() as { n: number } | null;
  return row?.n ?? 0;
}

/**
 * Delete the work-item graph and nothing else.
 *
 * `items` cannot simply be deleted in one statement: the hierarchy trigger
 * refuses to remove a row that still has children, so the depth is walked from
 * the leaves. The dependent tables (item links, history, mentions, comments,
 * item labels) are emptied after the items, once the graph is gone.
 */
export function clearWorkItems(db: Database): void {
  const leaves = "DELETE FROM items WHERE id NOT IN (SELECT parent_id FROM items WHERE parent_id IS NOT NULL)";
  db.transaction(() => {
    // Leaves first: the hierarchy trigger blocks removing a parent that still has
    // a child, so one statement removes a whole level and the loop is bounded by
    // the depth of the tree.
    for (;;) {
      const removed = db.query(leaves).run().changes;
      if (removed === 0) break;
    }
    const remaining = countItems(db);
    // The trigger makes a stuck cycle unreachable through the service; this is
    // the guard for a database edited by hand. It must not delete the remaining
    // rows out of order, so it stops instead and says so.
    if (remaining > 0) {
      throw new InternalError(
        `Refusing to clear the board: ${remaining} work item(s) form a hierarchy the delete cannot unwind.`,
      );
    }
    db.run("DELETE FROM item_links");
    db.run("DELETE FROM history");
    db.run("DELETE FROM mentions");
    db.run("DELETE FROM comments");
    db.run("DELETE FROM item_labels");
  })();
}

/**
 * Seed `db` with the development dataset.
 *
 * Throws a `ConflictError` when the board already holds items and `reset` was
 * not requested — the caller decides whether to pass it.
 */
export function seedBoard(db: Database, options: SeedOptions = {}): SeedSummary {
  const dataset = options.dataset ?? SEED_DATASET;
  const reset = options.reset ?? false;
  const service = new WorkboardService(db);

  const existing = countItems(db);
  if (existing > 0 && !reset) {
    throw new ConflictError(
      `This board already has ${existing} work item(s). Re-run with --reset to replace them, or --dir to point at an empty data directory.`,
    );
  }
  if (existing > 0) clearWorkItems(db);

  const participants = ensureParticipants(service, dataset.participants);
  const labels = ensureLabels(service, dataset.labels);
  // `items.created_by` is a foreign key, so every seeded item needs a real
  // participant. The default is the first human the dataset declares (a
  // pre-existing `admin` or `dev` participant wins, so a board that already has
  // an owner does not start attributing demo work to a stranger); agents are
  // the fallback because they can create work too.
  const defaultCreator = defaultCreatorFor(dataset, participants.map, service);
  const itemIds: Record<string, number> = {};
  let items = 0;
  let comments = 0;

  for (const item of dataset.items) {
    const created = createSeedItem(service, item, null, itemIds, participants.map, defaultCreator);
    items += created.items;
    comments += created.comments;
  }

  let relationships = 0;
  for (const relationship of dataset.relationships) {
    createSeedRelationship(service, relationship, itemIds, defaultCreator);
    relationships += 1;
  }

  return {
    reset: reset && existing > 0,
    participants: participants.created,
    labels: labels.created,
    items,
    comments,
    relationships,
    totalItems: countItems(db),
    itemIds,
  };
}

interface CreatedItem {
  readonly items: number;
  readonly comments: number;
}

function createSeedItem(
  service: WorkboardService,
  item: SeedItem,
  parentId: number | null,
  itemIds: Record<string, number>,
  participants: ReadonlyMap<string, number>,
  actor: Actor,
): CreatedItem {
  if (itemIds[item.key] !== undefined) {
    throw new Error(`Duplicate seed key: ${item.key}`);
  }
  // A nested item is a task unless the dataset says otherwise; a top-level item
  // is a user story, which is what the UI's quick add creates there.
  const type: WorkItemType = item.type ?? (parentId === null ? "user_story" : "task");
  const status: WorkStatus = item.status ?? "todo";
  const priority: Priority = item.priority ?? 2;
  const assigneeId = item.assignee === undefined ? null : requireParticipant(participants, item.assignee);
  const creator: Actor = item.creator === undefined
    ? actor
    : { ...actor, participantId: requireParticipant(participants, item.creator) };

  const detail = service.createItem(creator, {
    title: item.title,
    ...(item.body === undefined ? {} : { body: item.body }),
    type,
    priority,
    assigneeId,
    ...(parentId === null ? {} : { parentId }),
    ...(item.labels === undefined ? {} : { labels: [...item.labels] }),
  });
  itemIds[item.key] = detail.item.id;
  if (status !== "todo") service.updateItem(creator, detail.item.id, { status });

  let comments = 0;
  for (const comment of item.comments ?? []) {
    service.addComment(
      { ...actor, participantId: requireParticipant(participants, comment.author) },
      detail.item.id,
      { body: comment.body },
    );
    comments += 1;
  }

  let children = 0;
  let childComments = 0;
  for (const child of item.children ?? []) {
    const result = createSeedItem(service, child, detail.item.id, itemIds, participants, actor);
    children += result.items;
    childComments += result.comments;
  }
  return { items: 1 + children, comments: comments + childComments };
}

function defaultCreatorFor(
  dataset: SeedDataset,
  participants: ReadonlyMap<string, number>,
  service: WorkboardService,
): Actor {
  const existing = service.listParticipants(LOCAL_ACTOR_BOOTSTRAP);
  const firstHuman = existing.find((participant) => participant.kind === "human");
  if (firstHuman !== undefined) return { participantId: firstHuman.id, name: firstHuman.name, kind: firstHuman.kind };
  const datasetHuman = dataset.participants.find((participant) => participant.kind === "human")
    ?? dataset.participants[0];
  if (datasetHuman !== undefined) {
    return {
      participantId: requireParticipant(participants, datasetHuman.name),
      name: datasetHuman.name,
      kind: datasetHuman.kind,
    };
  }
  const anyExisting = existing[0];
  if (anyExisting !== undefined) {
    return { participantId: anyExisting.id, name: anyExisting.name, kind: anyExisting.kind };
  }
  throw new InternalError("A seed needs at least one participant to attribute created items to.");
}

function createSeedRelationship(
  service: WorkboardService,
  relationship: SeedRelationship,
  itemIds: Readonly<Record<string, number>>,
  actor: Actor,
): void {
  const from = itemIds[relationship.from];
  const to = itemIds[relationship.to];
  if (from === undefined || to === undefined) {
    throw new Error(`Seed relationship ${relationship.from} → ${relationship.to} names an unknown key`);
  }
  service.createRelationship(actor, from, { name: relationship.name, itemId: to });
}

function ensureParticipants(
  service: WorkboardService,
  desired: SeedDataset["participants"],
): { readonly map: Map<string, number>; readonly created: number } {
  const map = new Map(
    service.listParticipants(LOCAL_ACTOR_BOOTSTRAP).map((participant) => [participant.name.toLowerCase(), participant.id]),
  );
  let created = 0;
  for (const participant of desired) {
    const key = participant.name.toLowerCase();
    if (map.has(key)) continue;
    const row = service.createParticipant(LOCAL_ACTOR_BOOTSTRAP, {
      name: participant.name,
      kind: participant.kind,
      avatarColor: participant.avatarColor,
    });
    map.set(key, row.id);
    created += 1;
  }
  return { map, created };
}

function ensureLabels(
  service: WorkboardService,
  desired: SeedDataset["labels"],
): { readonly created: number } {
  const known = new Set(service.listLabels(LOCAL_ACTOR_BOOTSTRAP).map((label) => label.name.toLowerCase()));
  let created = 0;
  for (const label of desired) {
    const key = label.name.toLowerCase();
    if (known.has(key)) continue;
    service.createLabel(LOCAL_ACTOR_BOOTSTRAP, { name: label.name, color: label.color });
    known.add(key);
    created += 1;
  }
  return { created };
}

function requireParticipant(map: ReadonlyMap<string, number>, name: string): number {
  const id = map.get(name.toLowerCase());
  if (id === undefined) throw new Error(`Seed data references unknown participant: ${name}`);
  return id;
}
