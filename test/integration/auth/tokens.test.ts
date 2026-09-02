import { describe, expect, test } from "bun:test";
import { authenticate, issueToken, issueTokenFromSecret, revokeTokenById } from "../../../src/auth/service";
import { TOKEN_SECRET_LENGTH, TOKEN_SECRET_PREFIX, generateTokenSecret, tokenPrefixOf } from "../../../src/auth/tokens";
import type { Database } from "bun:sqlite";
import { initializeDatabase } from "../../../src/db/database";
import { createParticipant } from "../../../src/db/repositories/participants";
import { findTokenByDigest } from "../../../src/db/repositories/tokens";
import { withTempDataDir } from "../../helpers/temp-dir";

function setup(db: Database) {
  const human = createParticipant(db, {
    name: "alice",
    kind: "human",
    avatarColor: "#101010",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const agent = createParticipant(db, {
    name: "bot",
    kind: "agent",
    avatarColor: "#202020",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  return { human, agent };
}

describe("token secrets", () => {
  test("shape, uniqueness, and deterministic prefix/digest", () => {
    const a = generateTokenSecret();
    const b = generateTokenSecret();
    expect(a.plaintext).toMatch(/^wb_[A-Za-z0-9_-]{43}$/);
    expect(a.plaintext).toHaveLength(TOKEN_SECRET_LENGTH);
    expect(a.plaintext).not.toEqual(b.plaintext);
    expect(a.prefix).toBe(tokenPrefixOf(a.plaintext));
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("issueToken", () => {
  test("stores digest and prefix but never the plaintext", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const { human } = setup(db);
        const issued = issueToken(db, { participantId: human.id, name: "bootstrap", now: "2026-01-01T00:00:00.000Z" });
        expect(issued.plaintext).toMatch(/^wb_/);

        const rows = db.query("SELECT * FROM api_tokens").all() as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(1);
        const serialized = JSON.stringify(rows);
        expect(serialized).not.toContain(issued.plaintext);
        // Prefix is a non-secret identifier; digest differs from plaintext.
        const row = rows[0];
        expect(row?.token_prefix).toBe(issued.plaintext.slice(0, 11));
        expect(row?.secret_digest).not.toBe(issued.plaintext);
        expect(findTokenByDigest(db, issued.plaintext)).toBeNull();
      } finally {
        db.close();
      }
    });
  });
});

describe("authenticate", () => {
  test("valid token resolves the correct participant and touches last-used", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const { agent } = setup(db);
        const issued = issueToken(db, { participantId: agent.id, name: "dsh-local", now: "2026-01-01T00:00:00.000Z" });

        const actor = authenticate(db, issued.plaintext, "2026-01-02T00:00:00.000Z");
        expect(actor.participantId).toBe(agent.id);
        expect(actor.name).toBe("bot");
        expect(actor.kind).toBe("agent");

        const row = findTokenByDigest(db, issued.token.secret_digest);
        expect(row?.last_used_at).toBe("2026-01-02T00:00:00.000Z");

        // Attribution unchanged by the touch.
        const again = authenticate(db, issued.plaintext, "2026-01-03T00:00:00.000Z");
        expect(again.participantId).toBe(agent.id);
        expect(again.tokenId).toBe(issued.token.id);
      } finally {
        db.close();
      }
    });
  });

  test("malformed, unknown, and revoked tokens fail identically", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const { human, agent } = setup(db);
        const issued = issueToken(db, { participantId: human.id, name: "t1", now: "2026-01-01T00:00:00.000Z" });
        const revoked = issueToken(db, { participantId: agent.id, name: "t2", now: "2026-01-01T00:00:00.000Z" });
        revokeTokenById(db, revoked.token.id, "2026-01-02T00:00:00.000Z");

        const unknown = generateTokenSecret().plaintext; // well-formed but never issued

        const cases: Array<string | null | undefined> = [
          null,
          undefined,
          "",
          "not-a-token",
          `${TOKEN_SECRET_PREFIX}short`,
          `${issued.plaintext}x`,
          unknown,
          revoked.plaintext,
          issued.plaintext.slice(0, -1) + (issued.plaintext.endsWith("A") ? "B" : "A"),
        ];
        const messages = new Set<string>();
        for (const credential of cases) {
          try {
            authenticate(db, credential, "2026-01-03T00:00:00.000Z");
            throw new Error("authenticate should have thrown");
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            messages.add((error as Error).message);
          }
        }
        // One identical failure surface for every rejection reason.
        expect(messages.size).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  test("revocation takes effect immediately", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const { human } = setup(db);
        const issued = issueToken(db, { participantId: human.id, name: "t", now: "2026-01-01T00:00:00.000Z" });
        expect(authenticate(db, issued.plaintext, "2026-01-02T00:00:00.000Z").participantId).toBe(human.id);
        expect(revokeTokenById(db, issued.token.id, "2026-01-02T00:00:01.000Z")).toBe(true);
        expect(() => authenticate(db, issued.plaintext, "2026-01-02T00:00:02.000Z")).toThrow();
      } finally {
        db.close();
      }
    });
  });

  test("multiple tokens per participant resolve independently", () => {
    withTempDataDir((dir) => {
      const db = initializeDatabase(dir);
      try {
        const { agent } = setup(db);
        const one = issueToken(db, { participantId: agent.id, name: "one", now: "2026-01-01T00:00:00.000Z" });
        const secondSecret = generateTokenSecret();
        const two = issueTokenFromSecret(db, { participantId: agent.id, name: "two", plaintext: secondSecret.plaintext, now: "2026-01-01T00:00:00.000Z" });
        expect(one.token.id).not.toBe(two.id);
        expect(authenticate(db, one.plaintext, "2026-01-02T00:00:00.000Z").tokenId).toBe(one.token.id);
        expect(authenticate(db, secondSecret.plaintext, "2026-01-02T00:00:00.000Z").tokenId).toBe(two.id);
      } finally {
        db.close();
      }
    });
  });
});
