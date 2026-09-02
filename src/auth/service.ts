// Authentication service: the only component that turns a presented credential
// into an Actor. Transports hand over the credential; they never choose the
// actor. Every failure mode (missing, malformed, unknown, revoked) throws the
// identical AuthenticationError so nothing about a token's state leaks.
import type { Database } from "bun:sqlite";
import type { Actor } from "../domain/types";
import { AuthenticationError } from "../domain/errors";
import { getParticipantById } from "../db/repositories/participants";
import { createToken, findTokensByPrefix, revokeToken, touchToken } from "../db/repositories/tokens";
import type { TokenRow } from "../db/repositories/tokens";
import { TOKEN_SECRET_LENGTH, TOKEN_SECRET_PREFIX, digestsMatch, generateTokenSecret, tokenDigest, tokenPrefixOf } from "./tokens";

export interface AuthenticatedActor extends Actor {
  readonly tokenId: number;
}

export interface IssuedToken {
  readonly token: TokenRow;
  // The plaintext secret, shown exactly once at creation.
  readonly plaintext: string;
}

export function issueToken(
  db: Database,
  input: { readonly participantId: number; readonly name: string; readonly now: string },
): IssuedToken {
  const secret = generateTokenSecret();
  const token = createToken(db, {
    participantId: input.participantId,
    name: input.name,
    tokenPrefix: secret.prefix,
    secretDigest: secret.digest,
    createdAt: input.now,
  });
  return { token, plaintext: secret.plaintext };
}

export function issueTokenFromSecret(
  db: Database,
  input: { readonly participantId: number; readonly name: string; readonly plaintext: string; readonly now: string },
): TokenRow {
  return createToken(db, {
    participantId: input.participantId,
    name: input.name,
    tokenPrefix: tokenPrefixOf(input.plaintext),
    secretDigest: tokenDigest(input.plaintext),
    createdAt: input.now,
  });
}

export function authenticate(
  db: Database,
  credential: string | null | undefined,
  now: string,
): AuthenticatedActor {
  if (typeof credential !== "string") throw new AuthenticationError();
  if (credential.length !== TOKEN_SECRET_LENGTH) throw new AuthenticationError();
  if (!credential.startsWith(TOKEN_SECRET_PREFIX)) throw new AuthenticationError();

  const digest = tokenDigest(credential);
  let matched: TokenRow | null = null;
  for (const candidate of findTokensByPrefix(db, tokenPrefixOf(credential))) {
    if (digestsMatch(candidate.secret_digest, digest)) {
      matched = candidate;
      break;
    }
  }
  if (matched === null || matched.revoked_at !== null) throw new AuthenticationError();

  const participant = getParticipantById(db, matched.participant_id);
  if (participant === null) throw new AuthenticationError();

  touchToken(db, matched.id, now);
  return { participantId: participant.id, name: participant.name, kind: participant.kind, tokenId: matched.id };
}

export function revokeTokenById(db: Database, tokenId: number, now: string): boolean {
  return revokeToken(db, tokenId, now);
}
