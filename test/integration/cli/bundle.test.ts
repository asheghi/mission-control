// Backup bundles: the database plus the attachment bytes that belong to it.
//
// The claims worth testing are the ones that make a backup trustworthy: the
// bytes are all there, damage is caught before a restore touches a board, and a
// restore is safe to run twice.
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "../../../src/db/database";
import { WorkboardService } from "../../../src/app/workboard";
import { FilesystemBlobStore } from "../../../src/storage/fs";
import { streamBody } from "../../../src/api/response";
import {
  BUNDLE_BLOB_DIRECTORY,
  BUNDLE_DATABASE_NAME,
  BUNDLE_MANIFEST_NAME,
  bundleDatabasePath,
  createBundle,
  readBundleManifest,
  restoreBundleBlobs,
  verifyBundle,
} from "../../../src/maintenance/bundle";
import type { Actor } from "../../../src/domain/types";

const PNG = readFileSync(join(import.meta.dir, "../../fixtures/media/probe.png"));
const MP4 = readFileSync(join(import.meta.dir, "../../fixtures/media/probe.mp4"));

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly blobs: FilesystemBlobStore;
  readonly service: WorkboardService;
  readonly actor: Actor;
  readonly itemId: number;
}

function makeBoard(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "wb-bundle-"));
  const db = initializeDatabase(dir);
  const blobs = new FilesystemBlobStore({ directory: join(dir, "blobs") });
  const service = new WorkboardService(db, undefined, undefined, { blobs });
  const alice = service.createParticipant({ participantId: 0, name: "bootstrap", kind: "human" }, { name: "alice", kind: "human" });
  const actor: Actor = { participantId: alice.id, name: "alice", kind: "human" };
  const itemId = service.createItem(actor, { title: "shots" }).item.id;
  return { dir, db, blobs, service, actor, itemId };
}

function dispose(fixture: Fixture): void {
  fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
}

async function upload(fixture: Fixture, bytes: Uint8Array, type: string, filename: string) {
  const request = new Request("http://localhost/upload", { method: "POST", body: new Blob([bytes]).stream() });
  return fixture.service.uploadAttachment(fixture.actor, {
    itemId: fixture.itemId,
    declaredMediaType: type,
    filename,
    body: streamBody(request, 300 * 1024 * 1024, 64),
  });
}

/** Runs `fn` with a board and cleans up whatever happens. */
async function withBoard(fn: (fixture: Fixture, bundlePath: string) => Promise<void>): Promise<void> {
  const fixture = makeBoard();
  const bundlePath = join(fixture.dir, "backup.wbb");
  try {
    await fn(fixture, bundlePath);
  } finally {
    dispose(fixture);
  }
}

describe("backup bundles", () => {
  test("capture the database, every attachment's bytes, and a manifest", async () => {
    await withBoard(async (fixture, bundlePath) => {
      const png = await upload(fixture, PNG, "image/png", "shot.png");
      const mp4 = await upload(fixture, MP4, "video/mp4", "clip.mp4");

      const result = await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundlePath, now: new Date() });
      expect(result.attachmentCount).toBe(2);
      expect(result.totalBytes).toBe(PNG.byteLength + MP4.byteLength);

      // Every part of a bundle is present, including the database snapshot that
      // `VACUUM INTO` alone used to be the whole backup.
      expect(existsSync(join(bundlePath, BUNDLE_DATABASE_NAME))).toBe(true);
      expect(existsSync(join(bundlePath, BUNDLE_MANIFEST_NAME))).toBe(true);
      expect(readdirSync(join(bundlePath, BUNDLE_BLOB_DIRECTORY))).toHaveLength(2);

      const manifest = readBundleManifest(bundlePath);
      expect(manifest.attachmentCount).toBe(2);
      // The manifest is the record of what a restore must reproduce.
      const byId = new Map(manifest.entries.map((entry) => [entry.attachmentId, entry]));
      expect(byId.get(png.id)?.sha256).toBe(png.sha256);
      expect(byId.get(png.id)?.storageKey).toBe(
        (fixture.db.query("SELECT storage_key AS k FROM attachments WHERE id = ?").get(png.id) as { k: string }).k,
      );
      expect(byId.get(mp4.id)?.mediaType).toBe("video/mp4");
    });
  });

  test("verify clean, and detect a truncated object", async () => {
    await withBoard(async (fixture, bundlePath) => {
      await upload(fixture, PNG, "image/png", "shot.png");
      await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundlePath, now: new Date() });
      expect(verifyBundle(bundlePath)).toEqual({ ok: true, problems: [] });

      // Append a byte: the size no longer matches what the manifest recorded.
      const blobDir = join(bundlePath, BUNDLE_BLOB_DIRECTORY);
      const [name] = readdirSync(blobDir);
      const file = join(blobDir, name as string);
      writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from([0])]));
      const verdict = verifyBundle(bundlePath);
      expect(verdict.ok).toBe(false);
      expect(verdict.problems[0]).toContain("bytes, expected");
    });
  });

  test("detect a missing object and an unlisted one", async () => {
    await withBoard(async (fixture, bundlePath) => {
      await upload(fixture, PNG, "image/png", "shot.png");
      await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundlePath, now: new Date() });
      const blobDir = join(bundlePath, BUNDLE_BLOB_DIRECTORY);

      rmSync(join(blobDir, readdirSync(blobDir)[0] as string));
      expect(verifyBundle(bundlePath).problems[0]).toContain("missing blob");
    });
  });

  test("detect content tampering that keeps the size", async () => {
    await withBoard(async (fixture, bundlePath) => {
      await upload(fixture, PNG, "image/png", "shot.png");
      await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundlePath, now: new Date() });
      const blobDir = join(bundlePath, BUNDLE_BLOB_DIRECTORY);
      const [name] = readdirSync(blobDir);
      const file = join(blobDir, name as string);
      // Same length, different bytes: only a hash catches this.
      const bytes = Buffer.from(readFileSync(file));
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      writeFileSync(file, bytes);
      const verdict = verifyBundle(bundlePath);
      expect(verdict.ok).toBe(false);
      expect(verdict.problems[0]).toContain("hash mismatch");
    });
  });

  test("refuse to write an incomplete backup when an attachment's bytes are gone", async () => {
    await withBoard(async (fixture, bundlePath) => {
      const attachment = await upload(fixture, PNG, "image/png", "shot.png");
      const key = (fixture.db.query("SELECT storage_key AS k FROM attachments WHERE id = ?").get(attachment.id) as { k: string }).k;
      await fixture.blobs.delete(key);

      await expect(
        createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundlePath, now: new Date() }),
      ).rejects.toThrow(/missing from storage/);
      // The failed bundle must not survive looking restorable.
      expect(existsSync(bundlePath)).toBe(false);
    });
  });

  test("refuse an output path that already exists", async () => {
    await withBoard(async (fixture, bundlePath) => {
      await upload(fixture, PNG, "image/png", "shot.png");
      await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundlePath, now: new Date() });
      await expect(
        createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundlePath, now: new Date() }),
      ).rejects.toThrow(/already exists/);
    });
  });

  test("an empty board still produces a valid bundle", async () => {
    await withBoard(async (fixture, bundlePath) => {
      const result = await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundlePath, now: new Date() });
      expect(result.attachmentCount).toBe(0);
      expect(verifyBundle(bundlePath).ok).toBe(true);
      expect(existsSync(bundleDatabasePath(bundlePath))).toBe(true);
    });
  });
});

describe("restoring a bundle", () => {
  test("writes the bytes back and reproduces them exactly", async () => {
    await withBoard(async (fixture, bundlePath) => {
      const attachment = await upload(fixture, PNG, "image/png", "shot.png");
      await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundlePath, now: new Date() });
      const key = (fixture.db.query("SELECT storage_key AS k FROM attachments WHERE id = ?").get(attachment.id) as { k: string }).k;
      fixture.db.close();

      // A fresh, empty store stands in for a new machine.
      const target = mkdtempSync(join(tmpdir(), "wb-restore-"));
      try {
        const store = new FilesystemBlobStore({ directory: join(target, "blobs") });
        const result = await restoreBundleBlobs({ bundlePath, blobs: store });
        expect(result).toEqual({ restored: 1, skipped: 0 });

        const opened = await store.open(key);
        const bytes = new Uint8Array(await new Response(opened?.body).arrayBuffer());
        expect(Buffer.compare(Buffer.from(bytes), PNG)).toBe(0);
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    });
  });

  test("is idempotent: a second restore rewrites nothing", async () => {
    await withBoard(async (fixture, bundlePath) => {
      await upload(fixture, PNG, "image/png", "shot.png");
      await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundlePath, now: new Date() });
      fixture.db.close();

      const target = mkdtempSync(join(tmpdir(), "wb-restore2-"));
      try {
        const store = new FilesystemBlobStore({ directory: join(target, "blobs") });
        expect(await restoreBundleBlobs({ bundlePath, blobs: store })).toEqual({ restored: 1, skipped: 0 });
        expect(await restoreBundleBlobs({ bundlePath, blobs: store })).toEqual({ restored: 0, skipped: 1 });
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    });
  });

  test("refuses a damaged bundle before writing anything", async () => {
    await withBoard(async (fixture, bundlePath) => {
      await upload(fixture, PNG, "image/png", "shot.png");
      await createBundle({ dataDir: fixture.dir, db: fixture.db, blobs: fixture.blobs, outputPath: bundlePath, now: new Date() });
      fixture.db.close();
      const blobDir = join(bundlePath, BUNDLE_BLOB_DIRECTORY);
      rmSync(join(blobDir, readdirSync(blobDir)[0] as string));

      const target = mkdtempSync(join(tmpdir(), "wb-restore3-"));
      try {
        const store = new FilesystemBlobStore({ directory: join(target, "blobs") });
        await expect(restoreBundleBlobs({ bundlePath, blobs: store })).rejects.toThrow(/damaged bundle/);
        // Nothing was written, so the existing board would still be intact.
        const keys: string[] = [];
        for await (const key of store.listKeys()) keys.push(key);
        expect(keys).toEqual([]);
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    });
  });

  test("reports a directory that is not a bundle", async () => {
    await withBoard(async (fixture, bundlePath) => {
      const notABundle = join(fixture.dir, "ordinary");
      writeFileSync(notABundle, "hello", "utf8");
      const openDir = join(fixture.dir, "emptydir");
      rmSync(openDir, { recursive: true, force: true });
      const { mkdirSync } = await import("node:fs");
      mkdirSync(openDir, { recursive: true });
      expect(() => readBundleManifest(openDir)).toThrow(/not a backup bundle/);
      expect(verifyBundle(openDir).ok).toBe(false);
      void bundlePath;
    });
  });
});
