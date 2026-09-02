// Token secret generation and digesting.
//
// Secrets are 32 random bytes (Bun's CSPRNG) rendered as base64url with a
// "wb_" prefix. Because the secret is high-entropy and never human-chosen,
// a SHA-256 digest is the appropriate stored form: preimage resistance of the
// hash plus 256 bits of entropy makes the digest useless for recovery, and no
// password-stretching is needed. The digest is compared with a
// timing-safe primitive after an indexed prefix lookup.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_SECRET_PREFIX = "wb_";
const RANDOM_BYTES = 32;
export const TOKEN_PREFIX_LENGTH = TOKEN_SECRET_PREFIX.length + 8;
export const TOKEN_SECRET_LENGTH = TOKEN_SECRET_PREFIX.length + 43; // 43 = base64url(32 bytes)

export interface GeneratedSecret {
  readonly plaintext: string;
  readonly prefix: string;
  readonly digest: string;
}

export function generateTokenSecret(): GeneratedSecret {
  const plaintext = TOKEN_SECRET_PREFIX + randomBytes(RANDOM_BYTES).toString("base64url");
  return { plaintext, prefix: tokenPrefixOf(plaintext), digest: tokenDigest(plaintext) };
}

export function tokenPrefixOf(secret: string): string {
  return secret.slice(0, TOKEN_PREFIX_LENGTH);
}

export function tokenDigest(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Constant-time digest comparison. Both inputs must be hex SHA-256 digests. */
export function digestsMatch(storedDigest: string, computedDigest: string): boolean {
  const a = Buffer.from(storedDigest, "utf8");
  const b = Buffer.from(computedDigest, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
