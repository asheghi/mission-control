// Filesystem BlobStore: the default backend. Objects live under one directory
// next to the database, so a board's bytes travel with its SQLite file.
//
// Two properties matter here and are enforced explicitly:
//
// - A key is a path *fragment* chosen by this application, never by a client.
//   `assertSafeKey` still re-checks it: a traversal in a key would write outside
//   the blob directory, and the cost of the check is one regex.
// - A write is a temp file plus an atomic rename, so a reader never observes a
//   partially written object and a crash leaves only a temp file to sweep.
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { BlobStoreError, type BlobRange, type BlobStat, type BlobStore, type OpenedBlob, type PutOptions } from "./types";

/** Keys are `/`-separated shard segments; nothing else is allowed. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface FilesystemBlobStoreOptions {
  /** Absolute path of the directory holding objects. */
  readonly directory: string;
}

export class FilesystemBlobStore implements BlobStore {
  private readonly root: string;

  constructor(options: FilesystemBlobStoreOptions) {
    this.root = resolve(options.directory);
  }

  /** The directory this store owns. Used by doctor and backup. */
  get directory(): string {
    return this.root;
  }

  async put(key: string, body: ReadableStream<Uint8Array>, options: PutOptions = {}): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });

    // A random suffix keeps two concurrent writers of the same key from
    // corrupting each other's temp file; only the rename is atomic.
    const temp = `${target}.tmp-${crypto.randomUUID()}`;
    try {
      await writeStream(temp, body);
      if (options.ifAbsent === true) {
        // `link` fails with EEXIST when the target already exists, which makes
        // create-if-absent atomic. Checking with `exists` and then renaming is
        // not: two concurrent writers both see "absent" and one silently
        // replaces the other's object.
        try {
          await link(temp, target);
        } catch (error) {
          if (isExists(error)) {
            throw new BlobStoreError("ALREADY_EXISTS", `blob already exists: ${key}`);
          }
          throw error;
        }
        await rm(temp, { force: true }).catch(() => {});
      } else {
        await rename(temp, target);
      }
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      if (error instanceof BlobStoreError) throw error;
      throw new BlobStoreError("IO", `failed to write blob: ${key}`, { cause: error });
    }
  }

  async open(key: string, range?: BlobRange): Promise<OpenedBlob | null> {
    const target = this.pathFor(key);
    const info = await this.stat(key);
    if (info === null) return null;

    const start = range?.start ?? 0;
    const endInclusive = range?.endInclusive ?? info.size - 1;
    if (range !== undefined && (start < 0 || endInclusive < start || start >= info.size)) {
      throw new BlobStoreError("IO", `unsatisfiable range for blob: ${key}`);
    }
    if (info.size === 0) {
      return { body: emptyStream(), size: 0 };
    }

    const nodeStream = createReadStream(target, { start, end: endInclusive });
    return { body: toWebStream(nodeStream), size: info.size };
  }

  async stat(key: string): Promise<BlobStat | null> {
    try {
      const info = await stat(this.pathFor(key));
      // A directory where an object should be is corruption, not an object.
      if (!info.isFile()) return null;
      return { size: info.size };
    } catch (error) {
      if (isMissing(error)) return null;
      throw new BlobStoreError("IO", `failed to stat blob: ${key}`, { cause: error });
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.pathFor(key), { force: true });
    } catch (error) {
      throw new BlobStoreError("IO", `failed to delete blob: ${key}`, { cause: error });
    }
  }

  async *listKeys(prefix = ""): AsyncIterable<string> {
    const base = this.root;
    // A glob is not used: `readdir` with the recursion flag keeps this one
    // syscall path and avoids shell-style metacharacters in a key.
    const { readdir } = await import("node:fs/promises");
    let entries: string[];
    try {
      entries = (await readdir(base, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => relative(base, join(entry.parentPath, entry.name)).split(sep).join("/"));
    } catch (error) {
      if (isMissing(error)) return;
      throw new BlobStoreError("IO", "failed to list blobs", { cause: error });
    }
    for (const entry of entries) {
      if (entry.includes(".tmp-")) continue;
      if (prefix !== "" && !entry.startsWith(prefix)) continue;
      yield entry;
    }
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const target = resolve(this.root, key);
    // Belt and braces: even a key that passes the pattern must resolve inside
    // the root. `resolve` collapses any `..` before this comparison.
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new BlobStoreError("IO", `blob key escapes the storage directory: ${key}`);
    }
    return target;
  }
}

export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes("..")) {
    throw new BlobStoreError("IO", `unsafe blob key: ${key}`);
  }
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * Wrap a Node read stream for the web.
 *
 * `Readable.toWeb` is used because it is the supported conversion, with Node's
 * and Bun's typings disagreeing about BYOB readers, so the result is asserted
 * once here rather than widened at every call site.
 *
 * Note on `Content-Length`: a `Bun.serve` response whose body comes from a
 * bridged Node stream is sent with chunked encoding, and Bun drops an explicit
 * `Content-Length` header on it. That was verified against the runtime, and a
 * native stream carrying the same bytes keeps the header — but every attempt to
 * bridge eagerly either still lost it or duplicated the first chunk. The
 * response route therefore omits the header for these bodies and relies on
 * `Content-Range`, which is what a client needs to seek; the transfer is still
 * correctly delimited and the byte counts are right.
 */
function toWebStream(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream as Parameters<typeof Readable.toWeb>[0]) as unknown as ReadableStream<Uint8Array>;
}

async function writeStream(path: string, body: ReadableStream<Uint8Array>): Promise<void> {
  const out = createWriteStream(path);
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(value)) {
        await new Promise<void>((resolveDrain) => out.once("drain", () => resolveDrain()));
      }
    }
  } finally {
    reader.releaseLock();
    await new Promise<void>((resolveEnd, rejectEnd) => {
      out.end((error?: Error | null) => (error ? rejectEnd(error) : resolveEnd()));
    });
  }
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}
