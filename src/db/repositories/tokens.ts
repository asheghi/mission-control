import type { Database } from "bun:sqlite";

export interface TokenRow {
  readonly id: number;
  readonly participant_id: number;
  readonly name: string;
  readonly token_prefix: string;
  readonly secret_digest: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

export function createToken(
  db: Database,
  input: {
    readonly participantId: number;
    readonly name: string;
    readonly tokenPrefix: string;
    readonly secretDigest: string;
    readonly createdAt: string;
  },
): TokenRow {
  const row = db
    .query(
      "INSERT INTO api_tokens (participant_id, name, token_prefix, secret_digest, created_at) " +
        "VALUES (?, ?, ?, ?, ?) " +
        "RETURNING id, participant_id, name, token_prefix, secret_digest, created_at, last_used_at, revoked_at",
    )
    .get(input.participantId, input.name, input.tokenPrefix, input.secretDigest, input.createdAt);
  return row as TokenRow;
}

export function findTokenByDigest(db: Database, secretDigest: string): TokenRow | null {
  const row = db
    .query(
      "SELECT id, participant_id, name, token_prefix, secret_digest, created_at, last_used_at, revoked_at " +
        "FROM api_tokens WHERE secret_digest = ?",
    )
    .get(secretDigest);
  return (row as TokenRow | null) ?? null;
}

/** Prefix lookup (indexed, non-secret) narrows candidates for timing-safe comparison. */
export function findTokensByPrefix(db: Database, tokenPrefix: string): TokenRow[] {
  const rows = db
    .query(
      "SELECT id, participant_id, name, token_prefix, secret_digest, created_at, last_used_at, revoked_at " +
        "FROM api_tokens WHERE token_prefix = ?",
    )
    .all(tokenPrefix);
  return rows as TokenRow[];
}

export function revokeToken(db: Database, tokenId: number, revokedAt: string): boolean {
  const result = db
    .query("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(revokedAt, tokenId);
  return result.changes === 1;
}

export function touchToken(db: Database, tokenId: number, lastUsedAt: string): void {
  db.query("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(lastUsedAt, tokenId);
}
