// Attachment service behaviour: the ordering guarantees, the media checks, and
// the reconciliation paths. These are the claims the design rests on, so each
// one is exercised through the service rather than by inspecting rows.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { initializeDatabase } from "../../../src/db/database";
import { WorkboardService } from "../../../src/app/workboard";
import { FilesystemBlobStore } from "../../../src/storage/fs";
import { streamBody } from "../../../src/api/response";
import type { Actor } from "../../../src/domain/types";

const PNG = readFileSync(join(import.meta.dir, "../../fixtures/media/probe.png"));
const JPEG = readFileSync(join(import.meta.dir, "../../fixtures/media/probe.jpg"));
const MP4 = readFileSync(join(import.meta.dir, "../../fixtures/media/probe.mp4"));
const WEBM = readFileSync(join(import.meta.dir, "../../fixtures/media/probe.webm"));
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

interface Fixture {
  readonly db: Database;
  readonly blobs: FilesystemBlobStore;
  readonly service: WorkboardService;
  readonly actor: Actor;
  readonly itemId: number;
  readonly dir: string;
}

function withService(fn: (fixture: Fixture) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wb-att-"));
  const db = initializeDatabase(dir);
  const blobs = new FilesystemBlobStore({ directory: join(dir, "blobs") });
  const service = new WorkboardService(db, undefined, undefined, { blobs });
  const boss: Actor = { participantId: 0, name: "bootstrap", kind: "human" };
  const alice = service.createParticipant(boss, { name: "alice", kind: "human" });
  const actor: Actor = { participantId: alice.id, name: "alice", kind: "human" };
  const itemId = service.createItem(actor, { title: "screenshot bug" }).item.id;
  return Promise.resolve(fn({ db, blobs, service, actor, itemId, dir })).finally(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

/** Upload bytes the way a transport does: a streamed body plus a claimed type. */
function upload(
  fixture: Fixture,
  bytes: Uint8Array,
  declaredMediaType: string,
  options: { filename?: string | null; itemId?: number; commentId?: number; maxBytes?: number } = {},
) {
  const request = new Request("http://localhost/upload", {
    method: "POST",
    headers: { "content-type": declaredMediaType },
    body: new Blob([bytes]).stream(),
  });
  const maxBytes = options.maxBytes ?? 300 * 1024 * 1024;
  return fixture.service.uploadAttachment(fixture.actor, {
    ...(options.itemId !== undefined ? { itemId: options.itemId } : {}),
    ...(options.commentId !== undefined ? { commentId: options.commentId } : {}),
    declaredMediaType,
    filename: options.filename ?? "upload.bin",
    body: streamBody(request, maxBytes, 64),
  });
}

function countRows(db: Database, sql: string, ...params: unknown[]): number {
  return (db.query(sql).get(...(params as never[])) as { n: number }).n;
}

describe("attachment upload", () => {
  test("stores real image and video bytes and returns them unchanged", async () => {
    await withService(async (fixture) => {
      for (const [bytes, type] of [
        [PNG, "image/png"],
        [JPEG, "image/jpeg"],
        [MP4, "video/mp4"],
        [WEBM, "video/webm"],
      ] as const) {
        const attachment = await upload(fixture, bytes, type, { itemId: fixture.itemId });
        expect(attachment.mediaType).toBe(type);
        expect(attachment.sizeBytes).toBe(bytes.byteLength);
        expect(attachment.itemId).toBe(fixture.itemId);

        const opened = await fixture.service.openAttachment(fixture.actor, attachment.id);
        const roundTrip = new Uint8Array(await new Response(opened.body).arrayBuffer());
        expect(Buffer.compare(Buffer.from(roundTrip), Buffer.from(bytes))).toBe(0);
      }
    });
  });

  test("never exposes the storage key", async () => {
    await withService(async (fixture) => {
      const attachment = await upload(fixture, PNG, "image/png", { itemId: fixture.itemId });
      const serialized = JSON.stringify(attachment);
      expect(serialized).not.toContain("storageKey");
      // The key format is `attachments/<shard>/<id>`; only the deliberate
      // content route may contain the word "attachments".
      expect(Object.keys(attachment)).not.toContain("storageKey");
      expect(attachment.contentPath).toBe(`/api/attachments/${attachment.id}/content`);
    });
  });

  test("records a sha256 of what arrived, not what was claimed", async () => {
    await withService(async (fixture) => {
      const attachment = await upload(fixture, PNG, "image/png", { itemId: fixture.itemId });
      const expected = new Bun.CryptoHasher("sha256").update(PNG).digest("hex");
      expect(attachment.sha256).toBe(expected);
    });
  });

  test("refuses unsupported types, mismatched types, and unrecognisable bytes", async () => {
    await withService(async (fixture) => {
      // An image by intent, a script host by capability.
      await expect(upload(fixture, SVG, "image/svg+xml", { itemId: fixture.itemId })).rejects.toThrow(/Unsupported attachment type/);
      await expect(upload(fixture, PNG, "text/html", { itemId: fixture.itemId })).rejects.toThrow(/Unsupported attachment type/);
      await expect(upload(fixture, PNG, "application/octet-stream", { itemId: fixture.itemId })).rejects.toThrow(/Unsupported attachment type/);
      // A believable type that the bytes do not support.
      await expect(upload(fixture, PNG, "image/jpeg", { itemId: fixture.itemId })).rejects.toThrow(/is image\/png, not image\/jpeg/);
      // Nothing plausible at all.
      await expect(upload(fixture, new Uint8Array([1, 2, 3, 4]), "image/png", { itemId: fixture.itemId })).rejects.toThrow(
        /not a recognised image or video/,
      );
      expect(countRows(fixture.db, "SELECT COUNT(*) AS n FROM attachments")).toBe(0);
    });
  });

  test("sanitizes a hostile filename instead of using it as a path", async () => {
    await withService(async (fixture) => {
      const attachment = await upload(fixture, PNG, "image/png", {
        itemId: fixture.itemId,
        filename: "../../../etc/passwd",
      });
      expect(attachment.filename).toBe("passwd");
      // The object still lives under the sharded key, never near the filename.
      const key = (fixture.db.query("SELECT storage_key AS k FROM attachments WHERE id = ?").get(attachment.id) as { k: string }).k;
      expect(key.startsWith("attachments/")).toBe(true);
      expect(key).not.toContain("passwd");
    });
  });

  test("enforces the per-kind cap while streaming and leaves nothing behind", async () => {
    await withService(async (fixture) => {
      // A body larger than the cap: the write must abort rather than land.
      const oversized = new Uint8Array(2 * 1024 * 1024);
      oversized.set(PNG.subarray(0, 8), 0);
      await expect(
        upload(fixture, oversized, "image/png", { itemId: fixture.itemId, maxBytes: 64 * 1024 }),
      ).rejects.toThrow();
      // A refused upload must leave no row and no object.
      expect(countRows(fixture.db, "SELECT COUNT(*) AS n FROM attachments")).toBe(0);
      const keys: string[] = [];
      for await (const key of fixture.blobs.listKeys()) keys.push(key);
      expect(keys).toEqual([]);
    });
  });

  test("rejects a target that is neither or both, and an unknown parent", async () => {
    await withService(async (fixture) => {
      // The refinement's own message travels in `details.issues`, the way every
      // schema failure in this codebase reports itself.
      const neither = await rejectReason(
        fixture.service.uploadAttachment(fixture.actor, {
          declaredMediaType: "image/png",
          filename: "a.png",
          body: bodyFor(PNG),
        }),
      );
      expect(neither).toContain("exactly one of itemId or commentId");

      const both = await rejectReason(
        fixture.service.uploadAttachment(fixture.actor, {
          itemId: fixture.itemId,
          commentId: 1,
          declaredMediaType: "image/png",
          filename: "a.png",
          body: bodyFor(PNG),
        }),
      );
      expect(both).toContain("exactly one of itemId or commentId");

      await expect(upload(fixture, PNG, "image/png", { itemId: 9999 })).rejects.toThrow(/was not found/);
    });
  });

  test("attaches to a comment as well as an item", async () => {
    await withService(async (fixture) => {
      const comment = fixture.service.addComment(fixture.actor, fixture.itemId, { body: "see this" }).comment;
      const attachment = await upload(fixture, PNG, "image/png", { commentId: comment.id });
      expect(attachment.commentId).toBe(comment.id);
      expect(attachment.itemId).toBeNull();
      expect(fixture.service.listCommentAttachments(fixture.actor, comment.id).map((a) => a.id)).toEqual([attachment.id]);
      expect(fixture.service.listItemAttachments(fixture.actor, fixture.itemId)).toEqual([]);
    });
  });

  test("lists only committed attachments, in order", async () => {
    await withService(async (fixture) => {
      const first = await upload(fixture, PNG, "image/png", { itemId: fixture.itemId });
      const second = await upload(fixture, JPEG, "image/jpeg", { itemId: fixture.itemId });
      expect(fixture.service.listItemAttachments(fixture.actor, fixture.itemId).map((a) => a.id)).toEqual([first.id, second.id]);
      // A pending row is invisible to every read path.
      expect(countRows(fixture.db, "SELECT COUNT(*) AS n FROM attachments WHERE state = 'pending'")).toBe(0);
    });
  });
});

describe("attachment reads", () => {
  test("serves a byte range and reports the full size", async () => {
    await withService(async (fixture) => {
      const attachment = await upload(fixture, PNG, "image/png", { itemId: fixture.itemId });
      const ranged = await fixture.service.openAttachment(fixture.actor, attachment.id, { start: 1, endInclusive: 7 });
      const bytes = new Uint8Array(await new Response(ranged.body).arrayBuffer());
      expect(Array.from(bytes)).toEqual([0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      // The whole-object size, not the slice length: a range response needs both.
      expect(ranged.size).toBe(PNG.byteLength);
    });
  });

  test("reports an unusable range as a failure rather than a short read", async () => {
    await withService(async (fixture) => {
      const attachment = await upload(fixture, PNG, "image/png", { itemId: fixture.itemId });
      await expect(
        fixture.service.openAttachment(fixture.actor, attachment.id, { start: PNG.byteLength + 10, endInclusive: PNG.byteLength + 20 }),
      ).rejects.toThrow();
    });
  });

  test("treats a missing object behind a committed row as corruption", async () => {
    await withService(async (fixture) => {
      const attachment = await upload(fixture, PNG, "image/png", { itemId: fixture.itemId });
      const key = (fixture.db.query("SELECT storage_key AS k FROM attachments WHERE id = ?").get(attachment.id) as { k: string }).k;
      await fixture.blobs.delete(key);
      // The board says this exists, so its absence is a fault, not a 404.
      await expect(fixture.service.openAttachment(fixture.actor, attachment.id)).rejects.toThrow(/missing/);
    });
  });

  test("refuses unknown ids and unknown parents on listing", async () => {
    await withService(async (fixture) => {
      expect(() => fixture.service.getAttachment(fixture.actor, 999)).toThrow(/was not found/);
      expect(() => fixture.service.listItemAttachments(fixture.actor, 999)).toThrow(/was not found/);
      expect(() => fixture.service.listCommentAttachments(fixture.actor, 999)).toThrow(/was not found/);
    });
  });
});

describe("attachment deletion and reconciliation", () => {
  test("deleting an attachment removes its bytes and drains the queue", async () => {
    await withService(async (fixture) => {
      const attachment = await upload(fixture, PNG, "image/png", { itemId: fixture.itemId });
      const key = (fixture.db.query("SELECT storage_key AS k FROM attachments WHERE id = ?").get(attachment.id) as { k: string }).k;
      await fixture.service.deleteAttachment(fixture.actor, attachment.id);
      expect(await fixture.blobs.stat(key)).toBeNull();
      expect(countRows(fixture.db, "SELECT COUNT(*) AS n FROM blob_deletions")).toBe(0);
      expect(() => fixture.service.getAttachment(fixture.actor, attachment.id)).toThrow(/was not found/);
    });
  });

  test("deleting an item removes its attachments' bytes", async () => {
    await withService(async (fixture) => {
      const attachment = await upload(fixture, PNG, "image/png", { itemId: fixture.itemId });
      const key = (fixture.db.query("SELECT storage_key AS k FROM attachments WHERE id = ?").get(attachment.id) as { k: string }).k;
      fixture.service.deleteItem(fixture.actor, fixture.itemId);

      // The row is gone immediately, and the delete also works off the queue it
      // created. Asserting the queue still holds the key here would be asserting
      // a defect: nothing else in the product drains for this path, so those
      // bytes would stay forever.
      await fixture.service.drainBlobDeletions();
      expect(await fixture.blobs.stat(key)).toBeNull();
      expect(countRows(fixture.db, "SELECT COUNT(*) AS n FROM blob_deletions")).toBe(0);
      expect(countRows(fixture.db, "SELECT COUNT(*) AS n FROM attachments")).toBe(0);
    });
  });

  test("the queue keeps the key until the bytes are actually gone", async () => {
    await withService(async (fixture) => {
      // A store that refuses to delete: the durable record must survive, because
      // it is the only thing that would ever retry the removal.
      const attachment = await upload(fixture, PNG, "image/png", { itemId: fixture.itemId });
      const key = (fixture.db.query("SELECT storage_key AS k FROM attachments WHERE id = ?").get(attachment.id) as { k: string }).k;
      const stubborn = new WorkboardService(fixture.db, undefined, undefined, {
        blobs: {
          put: () => Promise.reject(new Error("unused")),
          open: () => Promise.resolve(null),
          stat: () => Promise.resolve(null),
          delete: () => Promise.reject(new Error("backend unavailable")),
          listKeys: async function* () {},
        },
      });
      const result = await stubborn.deleteAttachment(fixture.actor, attachment.id);
      void result;
      expect(countRows(fixture.db, "SELECT COUNT(*) AS n FROM blob_deletions")).toBe(1);
      const row = fixture.db.query("SELECT attempts FROM blob_deletions WHERE storage_key = ?").get(key) as { attempts: number };
      expect(row.attempts).toBe(1);
    });
  });

  test("deleting a comment cascades to its attachments' bytes", async () => {
    await withService(async (fixture) => {
      const comment = fixture.service.addComment(fixture.actor, fixture.itemId, { body: "shot" }).comment;
      const attachment = await upload(fixture, PNG, "image/png", { commentId: comment.id });
      const key = (fixture.db.query("SELECT storage_key AS k FROM attachments WHERE id = ?").get(attachment.id) as { k: string }).k;
      fixture.db.run("DELETE FROM comments WHERE id = ?", [comment.id]);
      expect(countRows(fixture.db, "SELECT COUNT(*) AS n FROM blob_deletions")).toBe(1);
      await fixture.service.drainBlobDeletions();
      expect(await fixture.blobs.stat(key)).toBeNull();
    });
  });

  test("a failed deletion stays queued with its attempt recorded", async () => {
    await withService(async (fixture) => {
      const attachment = await upload(fixture, PNG, "image/png", { itemId: fixture.itemId });
      await fixture.service.deleteAttachment(fixture.actor, attachment.id);
      // Simulate a backend that refuses to delete: the key must be re-queued
      // and the failure recorded, never silently dropped.
      fixture.db.run("INSERT INTO blob_deletions (storage_key, enqueued_at) VALUES (?, ?)", ["attachments/zz/ghost", "2026-01-01T00:00:00.000Z"]);
      const failing = new WorkboardService(fixture.db, undefined, undefined, {
        blobs: {
          put: () => Promise.reject(new Error("unused")),
          open: () => Promise.resolve(null),
          stat: () => Promise.resolve(null),
          delete: () => Promise.reject(new Error("backend unavailable")),
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          listKeys: async function* () {},
        },
      });
      const result = await failing.drainBlobDeletions();
      expect(result.failed).toBe(1);
      const row = fixture.db.query("SELECT attempts, last_error FROM blob_deletions WHERE storage_key = ?").get("attachments/zz/ghost") as {
        attempts: number;
        last_error: string | null;
      };
      expect(row.attempts).toBe(1);
      expect(row.last_error).toContain("backend unavailable");
    });
  });

  test("an abandoned pending row is swept, and its bytes are reclaimed", async () => {
    await withService(async (fixture) => {
      // Stand exactly where an interrupted upload leaves the board: a reserved
      // row whose bytes did land, but whose commit never ran.
      const key = "attachments/ee/abandoned";
      await fixture.blobs.put(key, new Blob([PNG]).stream(), { ifAbsent: true });
      fixture.db.run(
        "INSERT INTO attachments (item_id, storage_key, filename, media_type, state, created_by, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
        [fixture.itemId, key, "abandoned.png", "image/png", fixture.actor.participantId, "2020-01-01T00:00:00.000Z"],
      );
      expect(fixture.service.listItemAttachments(fixture.actor, fixture.itemId)).toEqual([]);

      const swept = await fixture.service.sweepPendingAttachments({ graceMs: 1000 });
      expect(swept.removed).toBe(1);
      expect(await fixture.blobs.stat(key)).toBeNull();
      expect(countRows(fixture.db, "SELECT COUNT(*) AS n FROM attachments")).toBe(0);
    });
  });

  test("a fresh pending row survives a sweep, so an in-flight upload is safe", async () => {
    await withService(async (fixture) => {
      fixture.db.run(
        "INSERT INTO attachments (item_id, storage_key, filename, media_type, state, created_by, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
        [fixture.itemId, "attachments/ff/active", "active.png", "image/png", fixture.actor.participantId, new Date().toISOString()],
      );
      const swept = await fixture.service.sweepPendingAttachments({ graceMs: 60 * 60 * 1000 });
      expect(swept.removed).toBe(0);
      expect(countRows(fixture.db, "SELECT COUNT(*) AS n FROM attachments")).toBe(1);
    });
  });
});

describe("board without storage configured", () => {
  test("refuses attachment work with a clear conflict instead of pretending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-noblob-"));
    const db = initializeDatabase(dir);
    try {
      const service = new WorkboardService(db);
      const boss: Actor = { participantId: 0, name: "bootstrap", kind: "human" };
      const alice = service.createParticipant(boss, { name: "alice", kind: "human" });
      const actor: Actor = { participantId: alice.id, name: "alice", kind: "human" };
      const itemId = service.createItem(actor, { title: "t" }).item.id;
      await expect(
        service.uploadAttachment(actor, {
          itemId,
          declaredMediaType: "image/png",
          filename: "a.png",
          body: bodyFor(PNG),
        }),
      ).rejects.toThrow(/No attachment storage is configured/);
      // A board with no backend has nothing to drain, and says so quietly.
      expect(await service.drainBlobDeletions()).toEqual({ deleted: 0, failed: 0 });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A streamed body built directly, for calls that never reach the bytes. */
function bodyFor(bytes: Uint8Array) {
  const request = new Request("http://localhost/upload", { method: "POST", body: new Blob([bytes]).stream() });
  return streamBody(request, 1024 * 1024, 64);
}

/** The readable reason a rejection carries, including schema issue text. */
async function rejectReason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "<resolved without error>";
  } catch (error) {
    const details = (error as { details?: { issues?: Array<{ message?: string }> } }).details;
    const issues = details?.issues?.map((issue) => issue.message ?? "").join(" ") ?? "";
    return `${(error as Error).message} ${issues}`;
  }
}
