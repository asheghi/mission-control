// Regression tests for defects found by adversarial review.
//
// Each case reproduces a specific failure that shipped once: a bundle that could
// publish arbitrary files, a backup whose manifest described a different moment
// than its database, a restore that kept corrupt bytes, an upload cap that was
// documented but not enforced, a maintenance pass that deleted a live upload,
// and a deletion queue that stranded objects. They are grouped here so the
// reason each assertion exists is legible next to the others.
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { initializeDatabase } from "../../../src/db/database";
import { WorkboardService } from "../../../src/app/workboard";
import { FilesystemBlobStore } from "../../../src/storage/fs";
import { streamBody } from "../../../src/api/response";
import { MAX_UPLOAD_BYTES } from "../../../src/app/attachment-policy";
import { ATTACHMENT_MAX_BYTES, sanitizeFilename } from "../../../src/domain/attachments";
import {
  BUNDLE_BLOB_DIRECTORY,
  BUNDLE_MANIFEST_NAME,
  createBundle,
  readBundleManifest,
  restoreBundleBlobs,
  verifyBundle,
} from "../../../src/maintenance/bundle";
import type { Actor } from "../../../src/domain/types";
import {
  claimRestoreLock,
  findRestoreHolder,
  PID_LOCK_STALE,
  releaseRestoreLock,
  restoreLockPath,
} from "../../../src/maintenance/serve-lock";

const PNG = readFileSync(join(import.meta.dir, "../../fixtures/media/probe.png"));

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly blobs: FilesystemBlobStore;
  readonly service: WorkboardService;
  readonly actor: Actor;
  readonly itemId: number;
}

function makeBoard(clock?: { now: () => string }): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "wb-reg-"));
  const db = initializeDatabase(dir);
  const blobs = new FilesystemBlobStore({ directory: join(dir, "blobs") });
  const service = new WorkboardService(db, clock as never, undefined, { blobs });
  const alice = service.createParticipant({ participantId: 0, name: "bootstrap", kind: "human" }, { name: "alice", kind: "human" });
  const actor: Actor = { participantId: alice.id, name: "alice", kind: "human" };
  const itemId = service.createItem(actor, { title: "t" }).item.id;
  return { dir, db, blobs, service, actor, itemId };
}

function dispose(fixture: Fixture): void {
  fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
}

function upload(fixture: Fixture, bytes: Uint8Array, type = "image/png", filename = "a.png") {
  return fixture.service.uploadAttachment(fixture.actor, {
    itemId: fixture.itemId,
    declaredMediaType: type,
    filename,
    body: streamBody(new Request("http://localhost/upload", { method: "POST", body: new Blob([bytes]).stream() }), MAX_UPLOAD_BYTES, 64),
  });
}

describe("bundle integrity", () => {
  test("a symlinked payload is refused, not followed", async () => {
    const fixture = makeBoard();
    const bundle = join(fixture.dir, "b.bin");
    try {
      await upload(fixture, PNG);
      await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundle, now: new Date() });

      // An attacker-supplied bundle points a payload at a file outside it and
      // supplies a manifest whose size and hash match that file.
      const secret = join(fixture.dir, "SECRET.txt");
      writeFileSync(secret, "TOP_SECRET_CONTENTS\n");
      const secretBytes = readFileSync(secret);
      const digest = new Bun.CryptoHasher("sha256").update(secretBytes).digest("hex");
      const blobDir = join(bundle, BUNDLE_BLOB_DIRECTORY);
      const name = readdirSync(blobDir)[0] as string;
      rmSync(join(blobDir, name));
      symlinkSync(secret, join(blobDir, name));
      const manifest = readBundleManifest(bundle);
      writeFileSync(
        join(bundle, BUNDLE_MANIFEST_NAME),
        JSON.stringify({
          ...manifest,
          totalBytes: secretBytes.byteLength,
          entries: manifest.entries.map((entry) => ({ ...entry, sizeBytes: secretBytes.byteLength, sha256: digest })),
        }),
      );

      const verdict = verifyBundle(bundle);
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(" ")).toContain("symbolic link");

      // And restore must not write the disclosed bytes anywhere.
      const target = mkdtempSync(join(tmpdir(), "wb-reg-restore-"));
      try {
        const store = new FilesystemBlobStore({ directory: join(target, "blobs") });
        await expect(restoreBundleBlobs({ bundlePath: bundle, blobs: store })).rejects.toThrow(/damaged bundle/);
        const keys: string[] = [];
        for await (const key of store.listKeys()) keys.push(key);
        expect(keys).toEqual([]);
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    } finally {
      dispose(fixture);
    }
  });

  test("a manifest that disagrees with the bundled database is reported", async () => {
    const fixture = makeBoard();
    const bundle = join(fixture.dir, "b.bin");
    try {
      await upload(fixture, PNG);
      await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundle, now: new Date() });

      // A database row with no manifest entry: verifying blobs alone would pass
      // this and restore a row whose bytes were never bundled.
      const manifest = readBundleManifest(bundle);
      writeFileSync(
        join(bundle, BUNDLE_MANIFEST_NAME),
        JSON.stringify({ ...manifest, entries: [], attachmentCount: 0, totalBytes: 0 }),
      );
      const verdict = verifyBundle(bundle);
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(" ")).toContain("absent from the manifest");
    } finally {
      dispose(fixture);
    }
  });

  test("restore replaces an existing object whose bytes are wrong", async () => {
    const fixture = makeBoard();
    const bundle = join(fixture.dir, "b.bin");
    try {
      await upload(fixture, PNG);
      await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundle, now: new Date() });
      const key = readBundleManifest(bundle).entries[0]?.storageKey as string;

      const target = mkdtempSync(join(tmpdir(), "wb-reg-restore-"));
      try {
        const store = new FilesystemBlobStore({ directory: join(target, "blobs") });
        const path = join(target, "blobs", key);
        mkdirSync(dirname(path), { recursive: true });
        // Same length, different bytes: existence alone would skip this.
        writeFileSync(path, Buffer.alloc(PNG.byteLength, 0x45));

        const result = await restoreBundleBlobs({ bundlePath: bundle, blobs: store });
        expect(result.restored).toBe(1);
        expect(result.skipped).toBe(0);
        const opened = await store.open(key);
        const bytes = new Uint8Array(await new Response(opened?.body).arrayBuffer());
        expect(Buffer.compare(Buffer.from(bytes), PNG)).toBe(0);
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    } finally {
      dispose(fixture);
    }
  });

  test("an extra nested file sharing a listed basename is detected", async () => {
    const fixture = makeBoard();
    const bundle = join(fixture.dir, "b.bin");
    try {
      await upload(fixture, PNG);
      await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundle, now: new Date() });
      const blobDir = join(bundle, BUNDLE_BLOB_DIRECTORY);
      const listed = readdirSync(blobDir)[0] as string;
      // A file under a subdirectory with the same leaf name: comparing basenames
      // would treat this as listed.
      mkdirSync(join(blobDir, "nested"), { recursive: true });
      writeFileSync(join(blobDir, "nested", listed), "extra");
      expect(verifyBundle(bundle).problems.join(" ")).toContain("unlisted blob");
    } finally {
      dispose(fixture);
    }
  });
});

describe("per-kind upload caps", () => {
  test("an image over 20 MiB is refused even under the global ceiling", async () => {
    const fixture = makeBoard();
    try {
      const size = ATTACHMENT_MAX_BYTES.image + 1024 * 1024;
      const body = new Uint8Array(size);
      body.set(PNG.subarray(0, 64), 0);
      // Declared length, so it is refused before streaming.
      const request = new Request("http://localhost/upload", {
        method: "POST",
        headers: { "content-length": String(size) },
        body: new Blob([body]).stream(),
      });
      const failure = await fixture.service
        .uploadAttachment(fixture.actor, {
          itemId: fixture.itemId,
          declaredMediaType: "image/png",
          filename: "big.png",
          body: streamBody(request, MAX_UPLOAD_BYTES, 64),
        })
        .then(() => null)
        .catch((error: unknown) => error);
      expect((failure as { code?: string })?.code).toBe("PAYLOAD_TOO_LARGE");
      expect((failure as Error).message).toContain("20 MiB");
      expect((fixture.db.query("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n).toBe(0);
    } finally {
      dispose(fixture);
    }
  });

  test("a client that hides its length is stopped mid-stream", async () => {
    const fixture = makeBoard();
    try {
      // No content-length: the cap must be enforced on the bytes that arrive.
      const size = ATTACHMENT_MAX_BYTES.image + 1024 * 1024;
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 0) {
            controller.enqueue(PNG.subarray(0, 64));
            sent += 64;
            return;
          }
          if (sent >= size) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(1024 * 1024));
          sent += 1024 * 1024;
        },
      });
      const request = new Request("http://localhost/upload", { method: "POST", body: stream, duplex: "half" });
      expect(request.headers.get("content-length")).toBeNull();

      const failure = await fixture.service
        .uploadAttachment(fixture.actor, {
          itemId: fixture.itemId,
          declaredMediaType: "image/png",
          filename: "big.png",
          body: streamBody(request, MAX_UPLOAD_BYTES, 64),
        })
        .then(() => null)
        .catch((error: unknown) => error);
      expect((failure as { code?: string })?.code).toBe("PAYLOAD_TOO_LARGE");

      // Nothing may be left behind by a refused upload.
      expect((fixture.db.query("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n).toBe(0);
      const keys: string[] = [];
      for await (const key of fixture.blobs.listKeys()) keys.push(key);
      expect(keys).toEqual([]);
    } finally {
      dispose(fixture);
    }
  });

  test("a video may exceed the image cap", async () => {
    const fixture = makeBoard();
    try {
      // Just over the image cap but far under the video cap, with a WebM header.
      const body = new Uint8Array(ATTACHMENT_MAX_BYTES.image + 1024);
      body.set([0x1a, 0x45, 0xdf, 0xa3], 0);
      body.set([0x42, 0x82, 0x84], 4);
      body.set(new TextEncoder().encode("webm"), 7);
      const request = new Request("http://localhost/upload", {
        method: "POST",
        headers: { "content-length": String(body.byteLength) },
        body: new Blob([body]).stream(),
      });
      const attachment = await fixture.service.uploadAttachment(fixture.actor, {
        itemId: fixture.itemId,
        declaredMediaType: "video/webm",
        filename: "clip.webm",
        body: streamBody(request, MAX_UPLOAD_BYTES, 64),
      });
      expect(attachment.kind).toBe("video");
      expect(attachment.sizeBytes).toBe(body.byteLength);
    } finally {
      dispose(fixture);
    }
  });
});

describe("deletion queue and upload lifecycle", () => {
  test("one drain pass clears a cascade larger than the batch size", async () => {
    const fixture = makeBoard();
    try {
      const count = 120;
      for (let index = 0; index < count; index += 1) await upload(fixture, PNG, "image/png", `f${index}.png`);
      fixture.service.deleteItem(fixture.actor, fixture.itemId);
      expect((fixture.db.query("SELECT COUNT(*) AS n FROM blob_deletions").get() as { n: number }).n).toBe(count);

      // A single batch would leave most of these stranded, and nothing in the
      // product calls drain again.
      const result = await fixture.service.drainBlobDeletions();
      expect(result.deleted).toBe(count);
      expect((fixture.db.query("SELECT COUNT(*) AS n FROM blob_deletions").get() as { n: number }).n).toBe(0);
      const keys: string[] = [];
      for await (const key of fixture.blobs.listKeys()) keys.push(key);
      expect(keys).toEqual([]);
    } finally {
      dispose(fixture);
    }
  });

  test("a failed upload leaves no queue row behind", async () => {
    const fixture = makeBoard();
    try {
      // A store that refuses to write, so the cleanup path runs.
      const failing = new WorkboardService(fixture.db, undefined, undefined, {
        blobs: {
          put: () => Promise.reject(new Error("write failed")),
          open: () => Promise.resolve(null),
          stat: () => Promise.resolve(null),
          delete: () => Promise.resolve(),
          listKeys: async function* () {},
        },
      });
      await expect(
        failing.uploadAttachment(fixture.actor, {
          itemId: fixture.itemId,
          declaredMediaType: "image/png",
          filename: "a.png",
          body: streamBody(new Request("http://localhost/upload", { method: "POST", body: new Blob([PNG]).stream() }), MAX_UPLOAD_BYTES, 64),
        }),
      ).rejects.toThrow();
      expect((fixture.db.query("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n).toBe(0);
      // Deleting the pending row queued its key; the immediate cleanup has to
      // clear that entry, or the queue grows forever with objects already gone.
      expect((fixture.db.query("SELECT COUNT(*) AS n FROM blob_deletions").get() as { n: number }).n).toBe(0);
    } finally {
      dispose(fixture);
    }
  });

  test("a sweep cannot delete an upload that is still running", async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const fixture = makeBoard({ now: () => new Date(nowMs).toISOString() });
    try {
      // Emits its prefix, then stalls while the clock jumps past the grace window.
      const slow = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new Uint8Array(PNG.subarray(0, 64)));
          await new Promise((resolve) => setTimeout(resolve, 250));
          controller.enqueue(new Uint8Array(PNG.subarray(64)));
          controller.close();
        },
      });
      const pending = fixture.service.uploadAttachment(fixture.actor, {
        itemId: fixture.itemId,
        declaredMediaType: "image/png",
        filename: "slow.png",
        body: streamBody(new Request("http://localhost/upload", { method: "POST", body: slow }), MAX_UPLOAD_BYTES, 64),
      });

      await new Promise((resolve) => setTimeout(resolve, 60));
      nowMs += 16 * 60 * 1000;
      // Age alone says "abandoned"; the lease says otherwise, and a 250 MiB
      // video can legitimately outlast any fixed grace window.
      expect((await fixture.service.sweepPendingAttachments({ graceMs: 15 * 60 * 1000 })).removed).toBe(0);
      const attachment = await pending;
      expect(attachment.sizeBytes).toBe(PNG.byteLength);
    } finally {
      dispose(fixture);
    }
  });

  test("a sweep still reclaims a genuinely abandoned row", async () => {
    const fixture = makeBoard();
    try {
      fixture.db.run(
        "INSERT INTO attachments (item_id, storage_key, filename, media_type, state, created_by, created_at) VALUES (?,?,?,?,'pending',?,?)",
        [fixture.itemId, "attachments/zz/abandoned", "abandoned.png", "image/png", fixture.actor.participantId, "2020-01-01T00:00:00.000Z"],
      );
      expect((await fixture.service.sweepPendingAttachments({ graceMs: 60_000 })).removed).toBe(1);
      expect((fixture.db.query("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n).toBe(0);
    } finally {
      dispose(fixture);
    }
  });
});

describe("storage backend guarantees", () => {
  test("ifAbsent admits exactly one concurrent writer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-reg-atomic-"));
    try {
      const store = new FilesystemBlobStore({ directory: dir });
      // Checking existence and then renaming lets both writers believe they won.
      const results = await Promise.allSettled([
        store.put("attachments/aa/key", new Blob([new Uint8Array([1, 1, 1])]).stream(), { ifAbsent: true }),
        store.put("attachments/aa/key", new Blob([new Uint8Array([2, 2, 2])]).stream(), { ifAbsent: true }),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      expect(fulfilled).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect((rejected.reason as { code?: string }).code).toBe("ALREADY_EXISTS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a blob key cannot escape the storage directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-reg-escape-"));
    try {
      const store = new FilesystemBlobStore({ directory: dir });
      // Keys that would leave the root, or that a shell or URL could misread.
      for (const key of ["../escape", "a/../../b", "/abs", "a b", "..", "....//x"]) {
        await expect(store.put(key, new Blob(["x"]).stream())).rejects.toThrow();
      }
      // A `.` segment is not an escape: it resolves to the same directory, so it
      // is allowed. What matters is that nothing lands outside the root.
      await store.put("a/./b", new Blob(["x"]).stream());
      const written = readdirSync(dir, { recursive: true }).map(String);
      expect(written.some((entry) => entry.includes(".."))).toBe(false);
      expect(await store.stat("a/b")).toEqual({ size: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("filenames", () => {
  test("a lone surrogate is normalized so the content route cannot fail", () => {
    // JSON and MCP both accept this, but `encodeURIComponent` throws on it —
    // which would make one attachment's content permanently return 500.
    const sanitized = sanitizeFilename("bad-\ud800.png");
    expect(() => encodeURIComponent(sanitized)).not.toThrow();
    expect(sanitized).toContain("\uFFFD");
    // A well-formed pair must survive untouched.
    expect(sanitizeFilename("emoji-\ud83d\ude00.png")).toBe("emoji-\ud83d\ude00.png");
  });
});

describe("second review round", () => {
  test("a failed upload whose cleanup also fails keeps its retry record", async () => {
    const fixture = makeBoard();
    try {
      // The worst case: storage may have written bytes, and the delete fails
      // too. Clearing the queue row here would orphan the object permanently,
      // because that row is the only remaining record of it.
      const stubborn = new WorkboardService(fixture.db, undefined, undefined, {
        blobs: {
          put: () => Promise.reject(new Error("write failed")),
          open: () => Promise.resolve(null),
          stat: () => Promise.resolve(null),
          delete: () => Promise.reject(new Error("delete failed")),
          listKeys: async function* () {},
        },
      });
      await expect(
        stubborn.uploadAttachment(fixture.actor, {
          itemId: fixture.itemId,
          declaredMediaType: "image/png",
          filename: "a.png",
          body: streamBody(new Request("http://localhost/upload", { method: "POST", body: new Blob([PNG]).stream() }), MAX_UPLOAD_BYTES, 64),
        }),
      ).rejects.toThrow();
      expect((fixture.db.query("SELECT COUNT(*) AS n FROM blob_deletions").get() as { n: number }).n).toBe(1);
    } finally {
      dispose(fixture);
    }
  });

  test("a successful cleanup retires its queue row", async () => {
    const fixture = makeBoard();
    try {
      const failing = new WorkboardService(fixture.db, undefined, undefined, {
        blobs: {
          put: () => Promise.reject(new Error("write failed")),
          open: () => Promise.resolve(null),
          stat: () => Promise.resolve(null),
          delete: () => Promise.resolve(),
          listKeys: async function* () {},
        },
      });
      await expect(
        failing.uploadAttachment(fixture.actor, {
          itemId: fixture.itemId,
          declaredMediaType: "image/png",
          filename: "a.png",
          body: streamBody(new Request("http://localhost/upload", { method: "POST", body: new Blob([PNG]).stream() }), MAX_UPLOAD_BYTES, 64),
        }),
      ).rejects.toThrow();
      expect((fixture.db.query("SELECT COUNT(*) AS n FROM blob_deletions").get() as { n: number }).n).toBe(0);
    } finally {
      dispose(fixture);
    }
  });

  test("deleting an item works off the deletion queue it created", async () => {
    const fixture = makeBoard();
    try {
      for (let index = 0; index < 4; index += 1) await upload(fixture, PNG, "image/png", `f${index}.png`);
      fixture.service.deleteItem(fixture.actor, fixture.itemId);
      // The drain is fire-and-forget from a synchronous delete, so the queue is
      // given a turn to work off before the assertion.
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Nothing else in the product calls drain for this path, so if the delete
      // does not, these objects stay forever.
      expect((fixture.db.query("SELECT COUNT(*) AS n FROM blob_deletions").get() as { n: number }).n).toBe(0);
      const keys: string[] = [];
      for await (const key of fixture.blobs.listKeys()) keys.push(key);
      expect(keys).toEqual([]);
    } finally {
      dispose(fixture);
    }
  });

  test("attachment events carry the owning item, for both parents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-reg-ev-"));
    const db = initializeDatabase(dir);
    const blobs = new FilesystemBlobStore({ directory: join(dir, "blobs") });
    const seen: Array<{ type: string; itemId: number | null }> = [];
    const service = new WorkboardService(db, undefined, { publish: (type, itemId) => seen.push({ type, itemId: itemId ?? null }) }, { blobs });
    try {
      const alice = service.createParticipant({ participantId: 0, name: "bootstrap", kind: "human" }, { name: "alice", kind: "human" });
      const actor: Actor = { participantId: alice.id, name: "alice", kind: "human" };
      const itemId = service.createItem(actor, { title: "t" }).item.id;
      const body = () =>
        streamBody(new Request("http://localhost/upload", { method: "POST", body: new Blob([PNG]).stream() }), MAX_UPLOAD_BYTES, 64);

      const itemAttachment = await service.uploadAttachment(actor, {
        itemId, declaredMediaType: "image/png", filename: "i.png", body: body(),
      });
      expect(seen.at(-1)).toEqual({ type: "attachment.created", itemId });

      // A comment attachment used to publish `comment.created` with a null item
      // id, which told every open client nothing about what had changed.
      const comment = service.addComment(actor, itemId, { body: "look" }).comment;
      await service.uploadAttachment(actor, { commentId: comment.id, declaredMediaType: "image/png", filename: "c.png", body: body() });
      expect(seen.at(-1)).toEqual({ type: "attachment.created", itemId });

      // Deletion was declared as an event type but never published.
      seen.length = 0;
      await service.deleteAttachment(actor, itemAttachment.id);
      expect(seen).toContainEqual({ type: "attachment.deleted", itemId });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("verification hashes a large object without buffering it", async () => {
    const fixture = makeBoard();
    const bundle = join(fixture.dir, "b.bin");
    try {
      // 24 MiB is enough to make an in-memory hash visible without slowing the
      // suite: reading the whole file would allocate at least that much.
      const size = 24 * 1024 * 1024;
      const body = new Uint8Array(size);
      body.set([0x1a, 0x45, 0xdf, 0xa3], 0);
      body.set([0x42, 0x82, 0x84], 4);
      body.set(new TextEncoder().encode("webm"), 7);
      await upload(fixture, body, "video/webm", "big.webm");
      await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundle, now: new Date() });

      const before = process.memoryUsage().heapUsed;
      expect(verifyBundle(bundle).ok).toBe(true);
      const growth = process.memoryUsage().heapUsed - before;
      // A buffering implementation allocates the object's full size; a streamed
      // one stays far below it.
      expect(growth).toBeLessThan(size / 2);
    } finally {
      dispose(fixture);
    }
  });

  test("a manifest naming one attachment twice is refused", async () => {
    const fixture = makeBoard();
    const bundle = join(fixture.dir, "b.bin");
    try {
      await upload(fixture, PNG);
      await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundle, now: new Date() });
      const manifest = readBundleManifest(bundle);
      // The cross-check keeps one entry per id while restore iterates all of
      // them, so a duplicate could write an unverified storage key.
      const duplicated = {
        ...manifest,
        entries: [manifest.entries[0], { ...(manifest.entries[0] as object), storageKey: "attachments/evil/key" }],
      };
      writeFileSync(join(bundle, BUNDLE_MANIFEST_NAME), JSON.stringify(duplicated));
      expect(() => readBundleManifest(bundle)).toThrow(/appears more than once/);
      expect(verifyBundle(bundle).ok).toBe(false);
    } finally {
      dispose(fixture);
    }
  });
});

describe("third review round", () => {
  test("a payload and manifest altered together still fail verification", async () => {
    const fixture = makeBoard();
    const bundle = join(fixture.dir, "b.bin");
    try {
      await upload(fixture, PNG);
      await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundle, now: new Date() });

      // Replace the payload AND rewrite the manifest to match it. The payload
      // now agrees with the manifest, so only a check against the bundled
      // database catches this — and the database is what a restore writes into
      // the board, so a mismatch there means the restored row would record a
      // hash its own bytes do not have.
      const blobDir = join(bundle, BUNDLE_BLOB_DIRECTORY);
      const name = readdirSync(blobDir)[0] as string;
      const replaced = Buffer.alloc(PNG.byteLength, 0x5a);
      writeFileSync(join(blobDir, name), replaced);
      const digest = new Bun.CryptoHasher("sha256").update(replaced).digest("hex");
      const manifest = readBundleManifest(bundle);
      writeFileSync(
        join(bundle, BUNDLE_MANIFEST_NAME),
        JSON.stringify({
          ...manifest,
          entries: manifest.entries.map((entry) => ({ ...entry, sha256: digest })),
        }),
      );

      const verdict = verifyBundle(bundle);
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(" ")).toContain("disagrees with the database");
    } finally {
      dispose(fixture);
    }
  });

  test("a manifest whose size disagrees with the database is refused", async () => {
    const fixture = makeBoard();
    const bundle = join(fixture.dir, "b.bin");
    try {
      await upload(fixture, PNG);
      await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundle, now: new Date() });
      const manifest = readBundleManifest(bundle);
      writeFileSync(
        join(bundle, BUNDLE_MANIFEST_NAME),
        JSON.stringify({
          ...manifest,
          entries: manifest.entries.map((entry) => ({ ...entry, sizeBytes: entry.sizeBytes + 1 })),
        }),
      );
      const verdict = verifyBundle(bundle);
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(" ")).toMatch(/bytes, (the database records|expected)/);
    } finally {
      dispose(fixture);
    }
  });
});

describe("restore locking", () => {
  test("a live restore holder never expires by age, and a dead one does not block", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-reg-lock-"));
    try {
      initializeDatabase(dir).close();
      expect(findRestoreHolder(dir)).toBeNull();

      // A live restore can legitimately spend hours copying a remote bundle.
      // Its marker remains authoritative even when its mtime is very old.
      const path = restoreLockPath(dir);
      writeFileSync(path, `${process.pid}\n`);
      const old = new Date("2000-01-01T00:00:00.000Z");
      utimesSync(path, old, old);
      expect(findRestoreHolder(dir)).toBe(process.pid);

      // A lock naming a process that cannot exist is stale, so it is ignored
      // rather than blocking every future serve forever.
      writeFileSync(path, "2147483646\n");
      expect(findRestoreHolder(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a permission error probing a PID is treated as a live holder", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-reg-lock-perm-"));
    const originalKill = process.kill;
    try {
      initializeDatabase(dir).close();
      const holder = 424_242;
      writeFileSync(restoreLockPath(dir), `${holder}\n`);
      process.kill = (() => {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      }) as typeof process.kill;
      expect(findRestoreHolder(dir)).toBe(holder);
    } finally {
      process.kill = originalKill;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("claiming the lock uses exclusive creation and rejects a second claimant", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-reg-lock2-"));
    try {
      initializeDatabase(dir).close();
      expect(claimRestoreLock(dir)).toBeNull();
      // Even another caller in this process must not be admitted: process-level
      // idempotence would let two embedded CLI invocations restore concurrently.
      expect(claimRestoreLock(dir)).toBe(process.pid);
      expect(findRestoreHolder(dir)).toBe(process.pid);
      releaseRestoreLock(dir);
      expect(findRestoreHolder(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two processes racing to claim admit exactly one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-reg-lock-race-"));
    try {
      initializeDatabase(dir).close();
      const modulePath = join(import.meta.dir, "../../../src/maintenance/serve-lock.ts");
      const script = `
        import { claimRestoreLock } from ${JSON.stringify(modulePath)};
        const result = claimRestoreLock(${JSON.stringify(dir)});
        console.log(String(result));
        await Bun.sleep(500);
      `;
      const children = [
        Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }),
        Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }),
      ];
      const outputs = await Promise.all(children.map((child) => new Response(child.stdout).text()));
      await Promise.all(children.map((child) => child.exited));
      const results = outputs.map((text) => text.trim());
      expect(results.filter((value) => value === "null")).toHaveLength(1);
      expect(results.filter((value) => value !== "null")).toHaveLength(1);
      const winnerIndex = results.findIndex((value) => value === "null");
      const loserIndex = winnerIndex === 0 ? 1 : 0;
      const winner = children[winnerIndex];
      if (winner === undefined) throw new Error("the lock race produced no winner");
      expect(Number(results[loserIndex])).toBe(winner.pid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a dead holder is reported without racy automatic takeover", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-reg-lock3-"));
    try {
      initializeDatabase(dir).close();
      const path = restoreLockPath(dir);
      writeFileSync(path, "2147483646\n");
      expect(claimRestoreLock(dir)).toBe(PID_LOCK_STALE);
      // Once an operator has confirmed the owner is dead and removed the stale
      // marker, the next atomic claim succeeds normally.
      rmSync(path);
      expect(claimRestoreLock(dir)).toBeNull();
      expect(findRestoreHolder(dir)).toBe(process.pid);
      releaseRestoreLock(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
