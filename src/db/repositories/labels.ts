import type { Database } from "bun:sqlite";

export interface LabelRow {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly created_at: string;
}

export function getLabelById(db: Database, id: number): LabelRow | null {
  const row = db.query("SELECT id, name, color, created_at FROM labels WHERE id = ?").get(id);
  return (row as LabelRow | null) ?? null;
}

export function getLabelByName(db: Database, name: string): LabelRow | null {
  const row = db.query("SELECT id, name, color, created_at FROM labels WHERE name = ?").get(name);
  return (row as LabelRow | null) ?? null;
}

export function listLabels(db: Database): LabelRow[] {
  const rows = db.query("SELECT id, name, color, created_at FROM labels ORDER BY name").all();
  return rows as LabelRow[];
}

export function createLabel(
  db: Database,
  input: { readonly name: string; readonly color: string; readonly createdAt: string },
): LabelRow {
  const row = db
    .query("INSERT INTO labels (name, color, created_at) VALUES (?, ?, ?) RETURNING id, name, color, created_at")
    .get(input.name, input.color, input.createdAt);
  return row as LabelRow;
}

export function listLabelsForItem(db: Database, itemId: number): LabelRow[] {
  const rows = db
    .query(
      "SELECT l.id, l.name, l.color, l.created_at FROM item_labels il " +
        "JOIN labels l ON l.id = il.label_id WHERE il.item_id = ? ORDER BY l.name",
    )
    .all(itemId);
  return rows as LabelRow[];
}

/** Batch label lookup for list/board views. */
export function labelsForItems(db: Database, itemIds: readonly number[]): Map<number, LabelRow[]> {
  const map = new Map<number, LabelRow[]>();
  if (itemIds.length === 0) return map;
  const placeholders = itemIds.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT il.item_id AS item_id, l.id, l.name, l.color, l.created_at
       FROM item_labels il JOIN labels l ON l.id = il.label_id
       WHERE il.item_id IN (${placeholders}) ORDER BY l.name`,
    )
    .all(...itemIds) as Array<{ item_id: number } & LabelRow>;
  for (const row of rows) {
    const existing = map.get(row.item_id) ?? [];
    existing.push({ id: row.id, name: row.name, color: row.color, created_at: row.created_at });
    map.set(row.item_id, existing);
  }
  return map;
}

export function setItemLabels(db: Database, itemId: number, labelIds: readonly number[]): void {
  db.query("DELETE FROM item_labels WHERE item_id = ?").run(itemId);
  const insert = db.query("INSERT OR IGNORE INTO item_labels (item_id, label_id) VALUES (?, ?)");
  for (const labelId of labelIds) {
    insert.run(itemId, labelId);
  }
}
