import type { Database } from "bun:sqlite";
import type { ParticipantKind } from "../../domain/types";

export interface ParticipantRow {
  readonly id: number;
  readonly name: string;
  readonly kind: ParticipantKind;
  readonly avatar_color: string;
  readonly created_at: string;
}

export function getParticipantById(db: Database, id: number): ParticipantRow | null {
  const row = db
    .query("SELECT id, name, kind, avatar_color, created_at FROM participants WHERE id = ?")
    .get(id);
  return (row as ParticipantRow | null) ?? null;
}

// Participant names are stored with COLLATE NOCASE, so this lookup is
// case-insensitive and is the canonical identity resolution.
export function getParticipantByName(db: Database, name: string): ParticipantRow | null {
  const row = db
    .query("SELECT id, name, kind, avatar_color, created_at FROM participants WHERE name = ?")
    .get(name);
  return (row as ParticipantRow | null) ?? null;
}

export function listParticipants(db: Database): ParticipantRow[] {
  const rows = db
    .query("SELECT id, name, kind, avatar_color, created_at FROM participants ORDER BY name")
    .all();
  return rows as ParticipantRow[];
}

// Renaming keeps id/kind/color/created_at; uniqueness is enforced by the
// participants table's COLLATE NOCASE UNIQUE index, so conflicting names clash
// case-insensitively.
export function updateParticipantName(db: Database, id: number, newName: string): ParticipantRow | null {
  const row = db
    .query("UPDATE participants SET name = ? WHERE id = ? RETURNING id, name, kind, avatar_color, created_at")
    .get(newName, id);
  return (row as ParticipantRow | null) ?? null;
}

export function createParticipant(
  db: Database,
  input: { readonly name: string; readonly kind: ParticipantKind; readonly avatarColor: string; readonly createdAt: string },
): ParticipantRow {
  const row = db
    .query(
      "INSERT INTO participants (name, kind, avatar_color, created_at) VALUES (?, ?, ?, ?) " +
        "RETURNING id, name, kind, avatar_color, created_at",
    )
    .get(input.name, input.kind, input.avatarColor, input.createdAt);
  return row as ParticipantRow;
}
