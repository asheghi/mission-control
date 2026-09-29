// Backup bundles: the database and the attachment bytes that belong to it.
//
// A `VACUUM INTO` snapshot alone would look like a successful backup and
// silently lose every attachment, because the bytes live outside SQLite. So a
// backup is a *bundle*: the snapshot, a manifest, and the referenced objects,
// with each object's size and hash verified as it is copied and again on
// restore. A backup that cannot be restored is worse than no backup at all.
//
// The same layout works for any backend, including S3: objects are streamed
// into the bundle rather than referenced, so a bundle stays portable and does
// not depend on a bucket still existing or still being reachable.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
import { Database as SqliteDatabase } from "bun:sqlite";
import { InternalError, ValidationError } from "../domain/errors";
import { listAllCommittedAttachments } from "../db/repositories/attachments";
import type { AttachmentRow } from "../db/repositories/attachments";
import type { BlobStore } from "../storage/types";
import { allocateBlobKey } from "./bundle-key";

export const BUNDLE_DATABASE_NAME = "workboard.sqlite";
export const BUNDLE_MANIFEST_NAME = "manifest.json";
export const BUNDLE_BLOB_DIRECTORY = "blobs";

export interface BundleManifestEntry {
  readonly attachmentId: number;
  readonly storageKey: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface BundleManifest {
  /** Bundle format version, so a future change can be detected rather than misread. */
  readonly formatVersion: 1;
  readonly createdAt: string;
  readonly attachmentCount: number;
  readonly totalBytes: number;
  readonly entries: readonly BundleManifestEntry[];
}

export interface CreateBundleOptions {
  readonly dataDir: string;
  readonly db: Database;
  readonly blobs: BlobStore;
  readonly outputPath: string;
  readonly now: Date;
}

export interface BundleResult {
  readonly path: string;
  readonly attachmentCount: number;
  readonly totalBytes: number;
}

/**
 * Write a complete backup bundle.
 *
 * Order matters: the database snapshot is taken first, and the manifest is then
 * derived FROM THAT SNAPSHOT rather than from the live database. Reading the
 * live database here instead would describe rows the snapshot may not contain —
 * a bundle whose manifest and database disagree, which still verifies clean and
 * restores into a board with attachments pointing at nothing.
 *
 * Each referenced object is then copied and checked against the snapshot's own
 * recorded size and hash. If anything is missing or mismatched, the whole bundle
 * is removed: a partial backup that restores into a board with broken
 * attachments is a trap.
 */
export async function createBundle(options: CreateBundleOptions): Promise<BundleResult> {
  const { dataDir, db, blobs, outputPath } = options;
  if (existsSync(outputPath)) {
    throw new ValidationError(`Backup target already exists: ${outputPath}`);
  }
  const blobRoot = join(outputPath, BUNDLE_BLOB_DIRECTORY);
  mkdirSync(blobRoot, { recursive: true });

  try {
    // 1. A consistent snapshot of the database.
    const snapshotPath = join(outputPath, BUNDLE_DATABASE_NAME);
    db.run("VACUUM INTO ?", [snapshotPath]);

    // 2. Every committed attachment in that snapshot, with its bytes. The rows
    //    come from the snapshot, so the manifest and the bundled database are
    //    the same moment in the board's life by construction.
    const rows = readSnapshotAttachments(snapshotPath);
    const entries: BundleManifestEntry[] = [];
    let totalBytes = 0;
    for (const row of rows) {
      const key = row.storage_key;
      const opened = await blobs.open(key);
      if (opened === null) {
        throw new InternalError(`Attachment ${row.id} is missing from storage; refusing to write an incomplete backup.`);
      }
      const hasher = new Bun.CryptoHasher("sha256");
      let size = 0;
      const target = join(blobRoot, allocateBlobKey(row.id, key));
      mkdirSync(join(target, ".."), { recursive: true });
      const sink = Bun.file(target).writer();
      const reader = opened.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hasher.update(value);
          size += value.byteLength;
          sink.write(value);
        }
      } finally {
        reader.releaseLock();
        await sink.end();
      }

      const digest = hasher.digest("hex");
      // The snapshot is authoritative for what a restore will expect, so a
      // disagreement between it and storage is corruption worth refusing.
      if (row.size_bytes !== null && row.size_bytes !== size) {
        throw new InternalError(
          `Attachment ${row.id} is ${size} bytes in storage but ${row.size_bytes} in the database.`,
        );
      }
      if (row.sha256 !== null && row.sha256 !== digest) {
        throw new InternalError(`Attachment ${row.id} does not match its recorded hash.`);
      }
      entries.push({
        attachmentId: row.id,
        storageKey: key,
        filename: row.filename,
        mediaType: row.media_type,
        sizeBytes: size,
        sha256: digest,
      });
      totalBytes += size;
    }

    // 3. The manifest, written last so a bundle without one is obviously partial.
    const manifest: BundleManifest = {
      formatVersion: 1,
      createdAt: options.now.toISOString(),
      attachmentCount: entries.length,
      totalBytes,
      entries,
    };
    writeFileSync(join(outputPath, BUNDLE_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    void dataDir;
    return { path: outputPath, attachmentCount: entries.length, totalBytes };
  } catch (error) {
    // Never leave a salvageable-looking bundle behind after a failure.
    rmSync(outputPath, { recursive: true, force: true });
    throw error;
  }
}


/**
 * Read the committed attachments recorded in a bundle's database snapshot.
 *
 * Opened read-only so a verification pass can never mutate the artifact it is
 * inspecting, and so the rows described are provably the rows that snapshot
 * holds rather than whatever the live board has since become.
 */
export function readSnapshotAttachments(snapshotPath: string): AttachmentRow[] {
  if (!existsSync(snapshotPath)) {
    throw new ValidationError(`No database snapshot at ${snapshotPath}.`);
  }
  const snapshot = new SqliteDatabase(snapshotPath, { readonly: true });
  try {
    return listAllCommittedAttachments(snapshot);
  } finally {
    snapshot.close();
  }
}

/**
 * Refuse a bundle whose blob payload is not a plain, contained regular file.
 *
 * `existsSync` and `statSync` follow symlinks, so a bundle that replaced a blob
 * with a link to `/etc/shadow` would be read, hashed against an attacker-supplied
 * manifest, and copied into storage — turning "restore this backup" into
 * "publish any file this process can read". Every component of the path is
 * checked, because a symlinked *directory* reaches the same place.
 */
function assertPlainBlobFile(bundlePath: string, target: string): void {
  const root = resolve(bundlePath, BUNDLE_BLOB_DIRECTORY);
  const resolved = resolve(target);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new ValidationError(`Bundle blob escapes the bundle directory: ${target}`);
  }
  // Walk the path from the bundle root down, refusing a link at any level.
  let current = root;
  for (const segment of relative(root, resolved).split(sep)) {
    current = join(current, segment);
    let info;
    try {
      info = lstatSync(current);
    } catch {
      throw new ValidationError(`Bundle blob is missing: ${target}`);
    }
    if (info.isSymbolicLink()) {
      throw new ValidationError(`Bundle blob is a symbolic link, which is not allowed: ${target}`);
    }
  }
  if (!lstatSync(resolved).isFile()) {
    throw new ValidationError(`Bundle blob is not a regular file: ${target}`);
  }
}

/** Read and validate a bundle's manifest, or explain why it is unusable. */
export function readBundleManifest(bundlePath: string): BundleManifest {
  const path = join(bundlePath, BUNDLE_MANIFEST_NAME);
  if (!existsSync(path)) {
    throw new ValidationError(`${bundlePath} is not a backup bundle: no ${BUNDLE_MANIFEST_NAME}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ValidationError(`${path} is not valid JSON.`, { cause: error instanceof Error ? error.message : String(error) });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ValidationError(`${path} is not a manifest object.`);
  }
  const record = parsed as Record<string, unknown>;
  if (record["formatVersion"] !== 1) {
    throw new ValidationError(`Unsupported bundle format version ${String(record["formatVersion"])}.`);
  }
  const entries = Array.isArray(record["entries"]) ? record["entries"] : null;
  if (entries === null) throw new ValidationError(`${path} has no entries array.`);

  // Every entry is checked structurally and must be unique by attachment id.
  // A duplicate is not merely untidy: the cross-check below keeps one entry per
  // id while the restore loop processes all of them, so a second entry naming a
  // different storage key would be written to storage without ever being
  // verified against the database.
  const seen = new Set<number>();
  for (const [index, raw] of entries.entries()) {
    if (typeof raw !== "object" || raw === null) {
      throw new ValidationError(`${path}: entry ${index} is not an object.`);
    }
    const entry = raw as Record<string, unknown>;
    const id = entry["attachmentId"];
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new ValidationError(`${path}: entry ${index} has an invalid attachmentId.`);
    }
    if (seen.has(id)) {
      throw new ValidationError(`${path}: attachment ${id} appears more than once in the manifest.`);
    }
    seen.add(id);
    if (typeof entry["storageKey"] !== "string" || entry["storageKey"] === "") {
      throw new ValidationError(`${path}: attachment ${id} has an invalid storageKey.`);
    }
    if (typeof entry["sizeBytes"] !== "number" || !Number.isSafeInteger(entry["sizeBytes"]) || entry["sizeBytes"] < 0) {
      throw new ValidationError(`${path}: attachment ${id} has an invalid sizeBytes.`);
    }
    if (typeof entry["sha256"] !== "string" || !/^[0-9a-f]{64}$/i.test(entry["sha256"])) {
      throw new ValidationError(`${path}: attachment ${id} has an invalid sha256.`);
    }
  }
  return parsed as BundleManifest;
}

/**
 * Verify a bundle's blob payload without restoring it.
 *
 * Every object the manifest names must be present with the recorded size and
 * hash. Used by `restore` to refuse a damaged bundle before touching a board,
 * and available on its own so a backup can be checked while it is still cheap
 * to make another one.
 */
export function verifyBundle(bundlePath: string): { readonly ok: boolean; readonly problems: readonly string[] } {
  const problems: string[] = [];
  let manifest: BundleManifest;
  try {
    manifest = readBundleManifest(bundlePath);
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)] };
  }
  const snapshotPath = join(bundlePath, BUNDLE_DATABASE_NAME);
  if (!existsSync(snapshotPath)) {
    problems.push(`missing ${BUNDLE_DATABASE_NAME}`);
  }

  for (const entry of manifest.entries) {
    const target = join(bundlePath, relativeBlobPath(entry.attachmentId, entry.storageKey));
    // A symlinked payload is refused outright. Following one would read whatever
    // it points at, hash it, and copy it into storage — an operator restoring a
    // supplied bundle would be publishing files this process can read.
    try {
      assertPlainBlobFile(bundlePath, target);
    } catch (error) {
      // Name the attachment the payload belongs to: "missing blob" alone leaves
      // an operator hunting through a bundle directory to find which one.
      const reason = error instanceof Error ? error.message : String(error);
      problems.push(reason.includes("is missing") ? `attachment ${entry.attachmentId}: missing blob` : reason);
      continue;
    }
    const info = statSync(target);
    if (info.size !== entry.sizeBytes) {
      problems.push(`attachment ${entry.attachmentId}: ${info.size} bytes, expected ${entry.sizeBytes}`);
      continue;
    }
    // Streamed, not `readFileSync`: an accepted video may be 250 MiB, and
    // verification must not need that much memory to confirm a hash.
    const digest = hashFile(target);
    if (digest !== entry.sha256) {
      problems.push(`attachment ${entry.attachmentId}: hash mismatch`);
    }
  }

  // The manifest and the bundled database must describe the same attachments.
  // Verifying blobs alone would pass a bundle whose database still lists an
  // attachment whose bytes were dropped from the manifest.
  if (existsSync(snapshotPath)) {
    try {
      const rows = readSnapshotAttachments(snapshotPath);
      const described = new Map(manifest.entries.map((entry) => [entry.attachmentId, entry]));
      for (const row of rows) {
        const entry = described.get(row.id);
        if (entry === undefined) {
          problems.push(`attachment ${row.id}: in the database but absent from the manifest`);
          continue;
        }
        if (entry.storageKey !== row.storage_key) {
          problems.push(`attachment ${row.id}: manifest names a different storage key than the database`);
        }
        // The database is what a restore writes into the board, so the manifest
        // must agree with IT, not merely with the payload. Checking the payload
        // alone passes a bundle whose manifest and database were altered
        // together: the restored row would then record a size and hash that the
        // stored bytes do not have, which every later integrity check reports as
        // corruption with no way to tell which side is wrong.
        if (row.size_bytes !== null && entry.sizeBytes !== row.size_bytes) {
          problems.push(
            `attachment ${row.id}: manifest says ${entry.sizeBytes} bytes, the database records ${row.size_bytes}`,
          );
        }
        if (row.sha256 !== null && entry.sha256.toLowerCase() !== row.sha256.toLowerCase()) {
          problems.push(`attachment ${row.id}: manifest hash disagrees with the database`);
        }
      }
      const rowIds = new Set(rows.map((row) => row.id));
      for (const entry of manifest.entries) {
        if (!rowIds.has(entry.attachmentId)) {
          problems.push(`attachment ${entry.attachmentId}: in the manifest but not in the database`);
        }
      }
    } catch (error) {
      problems.push(`cannot read the bundled database: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Objects present but unlisted mean the bundle was assembled wrongly; they
  // are reported rather than ignored, because a restore would drop them.
  const blobRoot = join(bundlePath, BUNDLE_BLOB_DIRECTORY);
  if (existsSync(blobRoot)) {
    // Compare full paths relative to the blob root, not bare basenames: two
    // entries could otherwise share a leaf name and let an extra nested file
    // pass as listed.
    const listed = new Set(
      manifest.entries.map((entry) => relPosix(relative(blobRoot, resolve(bundlePath, relativeBlobPath(entry.attachmentId, entry.storageKey))))),
    );
    for (const found of walkFiles(blobRoot)) {
      const relativePath = relPosix(relative(blobRoot, found));
      if (!listed.has(relativePath)) problems.push(`unlisted blob in bundle: ${relativePath}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** The bundle-relative path for an attachment's blob. Mirrors the writer. */
export function relativeBlobPath(attachmentId: number, storageKey: string): string {
  return join(BUNDLE_BLOB_DIRECTORY, allocateBlobKey(attachmentId, storageKey));
}

/** SHA-256 of a file, read in bounded chunks so size does not drive memory. */
function hashFile(path: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.byteLength, null);
      if (read <= 0) break;
      hasher.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hasher.digest("hex");
}

function relPosix(path: string): string {
  return path.split(sep).join("/");
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

/** Absolute path of a bundle's blob, for a restore to read. */
export function bundleBlobPath(bundlePath: string, attachmentId: number, storageKey: string): string {
  return resolve(bundlePath, relativeBlobPath(attachmentId, storageKey));
}

// --- Restore ------------------------------------------------------------------

export interface RestoreBundleOptions {
  readonly bundlePath: string;
  /** The store the restored bytes are written back into. */
  readonly blobs: BlobStore;
}

/**
 * Copy a bundle's blobs back into a store.
 *
 * Runs before the database is swapped in: a restore that replaced the database
 * first and then failed to write the bytes would leave a board whose
 * attachments are all broken. Writing bytes first means a failure here leaves
 * the previous board untouched.
 *
 * Objects already present are left alone, so restoring over a board that still
 * has the same attachments does not rewrite them.
 */
export async function restoreBundleBlobs(options: RestoreBundleOptions): Promise<{ restored: number; skipped: number }> {
  const manifest = readBundleManifest(options.bundlePath);
  const verdict = verifyBundle(options.bundlePath);
  if (!verdict.ok) {
    throw new ValidationError(`Refusing to restore a damaged bundle: ${verdict.problems.slice(0, 3).join("; ")}`);
  }

  let restored = 0;
  let skipped = 0;
  for (const entry of manifest.entries) {
    const source = bundleBlobPath(options.bundlePath, entry.attachmentId, entry.storageKey);
    // The payload is re-checked here, not just in verifyBundle: verification and
    // restore are separate calls, and a symlink swapped in between them would
    // otherwise be followed on this path.
    assertPlainBlobFile(options.bundlePath, source);

    // An object already present is only skipped when it is byte-for-byte the
    // one the bundle carries. Skipping on mere existence would leave a corrupt
    // or unrelated object in place and hand back a database whose recorded
    // size and hash do not match storage.
    const existing = await options.blobs.stat(entry.storageKey);
    if (existing !== null && existing.size === entry.sizeBytes && (await blobMatchesDigest(options.blobs, entry.storageKey, entry.sha256))) {
      skipped += 1;
      continue;
    }

    await options.blobs.put(entry.storageKey, Bun.file(source).stream());

    // Confirm the bytes actually landed: a store that silently accepts a write
    // would otherwise leave a restored board with unreachable attachments.
    const stored = await options.blobs.stat(entry.storageKey);
    if (stored === null || stored.size !== entry.sizeBytes) {
      throw new InternalError(`Failed to restore attachment ${entry.attachmentId} into storage.`);
    }
    if (!(await blobMatchesDigest(options.blobs, entry.storageKey, entry.sha256))) {
      throw new InternalError(`Attachment ${entry.attachmentId} did not restore with the expected contents.`);
    }
    restored += 1;
  }
  return { restored, skipped };
}

/** Stream an object and compare its digest, without holding it in memory. */
async function blobMatchesDigest(blobs: BlobStore, key: string, expected: string): Promise<boolean> {
  const opened = await blobs.open(key);
  if (opened === null) return false;
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = opened.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return hasher.digest("hex") === expected;
}

/** The database snapshot inside a bundle, ready to be validated and swapped in. */
export function bundleDatabasePath(bundlePath: string): string {
  return join(bundlePath, BUNDLE_DATABASE_NAME);
}

/** Default location for a backup bundle: beside the database, stamped by time. */
export function defaultBundlePath(dataDir: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(dataDir, "backups", `workboard-${stamp}.wbb`);
}
