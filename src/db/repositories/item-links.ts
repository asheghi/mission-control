import type { Database } from "bun:sqlite";
import { ConflictError, ValidationError } from "../../domain/errors";
import type { StoredItemLinkKind } from "../../domain/types";
import { STORED_ITEM_LINK_KINDS } from "../../domain/types";

export interface ItemLinkRow {
  readonly id: number;
  readonly kind: StoredItemLinkKind;
  readonly source_item_id: number;
  readonly target_item_id: number;
  readonly created_by: number;
  readonly created_at: string;
}

const COLUMNS = "id, kind, source_item_id, target_item_id, created_by, created_at";

function requireId(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`${name} must be a positive item id.`);
  }
  return value;
}

function requireKind(value: StoredItemLinkKind): StoredItemLinkKind {
  if (!(STORED_ITEM_LINK_KINDS as readonly string[]).includes(value)) {
    throw new ValidationError("Unsupported relationship kind.");
  }
  return value;
}

export function normalizeItemLink(
  kind: StoredItemLinkKind,
  sourceItemId: number,
  targetItemId: number,
): { readonly sourceItemId: number; readonly targetItemId: number } {
  requireKind(kind);
  requireId(sourceItemId, "sourceItemId");
  requireId(targetItemId, "targetItemId");
  if (sourceItemId === targetItemId) throw new ValidationError("An item cannot be linked to itself.");
  if (kind === "related" && sourceItemId > targetItemId) {
    return { sourceItemId: targetItemId, targetItemId: sourceItemId };
  }
  return { sourceItemId, targetItemId };
}

export function getItemLinkById(db: Database, id: number): ItemLinkRow | null {
  const row = db.query(`SELECT ${COLUMNS} FROM item_links WHERE id = ?`).get(id);
  return (row as ItemLinkRow | null) ?? null;
}

export function listItemLinks(db: Database, itemId: number): ItemLinkRow[] {
  requireId(itemId, "itemId");
  return db
    .query(
      `SELECT ${COLUMNS} FROM item_links ` +
        "WHERE source_item_id = ? OR target_item_id = ? ORDER BY kind, id",
    )
    .all(itemId, itemId) as ItemLinkRow[];
}

export function listItemLinksForItems(db: Database, itemIds: readonly number[]): Map<number, ItemLinkRow[]> {
  const unique = [...new Set(itemIds)];
  const result = new Map<number, ItemLinkRow[]>();
  if (unique.length === 0) return result;
  for (const id of unique) {
    requireId(id, "itemId");
    result.set(id, []);
  }
  const placeholders = unique.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT ${COLUMNS} FROM item_links WHERE source_item_id IN (${placeholders}) ` +
        `OR target_item_id IN (${placeholders}) ORDER BY kind, id`,
    )
    .all(...unique, ...unique) as ItemLinkRow[];
  for (const row of rows) {
    result.get(row.source_item_id)?.push(row);
    if (row.target_item_id !== row.source_item_id) result.get(row.target_item_id)?.push(row);
  }
  return result;
}

export function isDependencyReachable(db: Database, fromItemId: number, toItemId: number): boolean {
  requireId(fromItemId, "fromItemId");
  requireId(toItemId, "toItemId");
  if (fromItemId === toItemId) return true;
  const row = db
    .query(
      `WITH RECURSIVE reachable(id) AS (
         SELECT target_item_id FROM item_links
         WHERE kind = 'dependency' AND source_item_id = ?
         UNION
         SELECT links.target_item_id
         FROM item_links links JOIN reachable ON links.source_item_id = reachable.id
         WHERE links.kind = 'dependency'
       )
       SELECT 1 AS found FROM reachable WHERE id = ? LIMIT 1`,
    )
    .get(fromItemId, toItemId);
  return row !== null;
}

function isDuplicateReachable(db: Database, fromItemId: number, toItemId: number): boolean {
  const row = db
    .query(
      `WITH RECURSIVE originals(id) AS (
         SELECT target_item_id FROM item_links
         WHERE kind = 'duplicate' AND source_item_id = ?
         UNION
         SELECT links.target_item_id
         FROM item_links links JOIN originals ON links.source_item_id = originals.id
         WHERE links.kind = 'duplicate'
       )
       SELECT 1 AS found FROM originals WHERE id = ? LIMIT 1`,
    )
    .get(fromItemId, toItemId);
  return row !== null;
}

export function createItemLink(
  db: Database,
  input: {
    readonly kind: StoredItemLinkKind;
    readonly sourceItemId: number;
    readonly targetItemId: number;
    readonly createdBy: number;
    readonly createdAt: string;
  },
): ItemLinkRow {
  const endpoints = normalizeItemLink(input.kind, input.sourceItemId, input.targetItemId);
  const existing = db
    .query(
      "SELECT id FROM item_links WHERE kind = ? AND source_item_id = ? AND target_item_id = ?",
    )
    .get(input.kind, endpoints.sourceItemId, endpoints.targetItemId);
  if (existing !== null) throw new ConflictError("This relationship already exists.");

  if (input.kind === "dependency" && isDependencyReachable(db, endpoints.targetItemId, endpoints.sourceItemId)) {
    throw new ConflictError("This dependency would create a cycle.");
  }
  if (input.kind === "duplicate") {
    const original = db
      .query("SELECT target_item_id FROM item_links WHERE kind = 'duplicate' AND source_item_id = ?")
      .get(endpoints.sourceItemId) as { target_item_id: number } | null;
    if (original !== null) throw new ConflictError("This item already duplicates another item.");
    if (isDuplicateReachable(db, endpoints.targetItemId, endpoints.sourceItemId)) {
      throw new ConflictError("This duplicate relationship would create a cycle.");
    }
  }

  try {
    return db
      .query(
        `INSERT INTO item_links (kind, source_item_id, target_item_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
      )
      .get(
        input.kind,
        endpoints.sourceItemId,
        endpoints.targetItemId,
        input.createdBy,
        input.createdAt,
      ) as ItemLinkRow;
  } catch (error) {
    if (error instanceof Error && /FOREIGN KEY constraint/.test(error.message)) {
      throw new ValidationError("A linked item or actor does not exist.");
    }
    throw error;
  }
}

export function deleteItemLink(db: Database, id: number): boolean {
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError("relationshipId must be positive.");
  return db.query("DELETE FROM item_links WHERE id = ?").run(id).changes > 0;
}
