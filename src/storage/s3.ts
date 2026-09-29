// S3-compatible BlobStore, built on Bun's native `S3Client` (no SDK dependency).
//
// Three details of Bun's S3 surface shape this implementation, and each was
// verified against the installed runtime rather than assumed:
//
// - `file.slice(a, b)` is synchronous and lazy and performs a ranged GET when
//   read, so ranged reads are built from `slice`. `file.stream({...})` does NOT
//   accept a range — it throws — so it is not used for that.
// - Streaming writes go through `file.writer()`, which performs multipart
//   uploads for large objects, so a 250 MiB video never lands in memory.
// - Credentials come from the environment by default; `bucket`, `endpoint`,
//   `region`, and `prefix` are what this application configures.
import { S3Client } from "bun";
import { BlobStoreError, type BlobRange, type BlobStat, type BlobStore, type OpenedBlob, type PutOptions } from "./types";

export interface S3BlobStoreOptions {
  readonly bucket: string;
  readonly endpoint?: string;
  readonly region?: string;
  /** Key prefix inside the bucket, so a shared bucket stays enumerable. */
  readonly prefix?: string;
}

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(options: S3BlobStoreOptions) {
    this.prefix = options.prefix === undefined ? "" : normalizePrefix(options.prefix);
    this.client = new S3Client({
      bucket: options.bucket,
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      ...(options.region !== undefined ? { region: options.region } : {}),
    });
  }

  async put(key: string, body: ReadableStream<Uint8Array>, options: PutOptions = {}): Promise<void> {
    const target = this.client.file(this.objectKey(key));
    if (options.ifAbsent === true && (await this.exists(target))) {
      throw new BlobStoreError("ALREADY_EXISTS", `blob already exists: ${key}`);
    }
    let written = 0;
    try {
      // `writer` streams and switches to multipart automatically, which is what
      // keeps a large video out of memory.
      const writer = target.writer({ retry: 3, queueSize: 10, partSize: 5 * 1024 * 1024 });
      try {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          written += value.byteLength;
          await writer.write(value);
        }
        reader.releaseLock();
      } finally {
        await writer.end();
      }
    } catch (error) {
      throw new BlobStoreError("IO", `failed to write blob: ${key}`, { cause: error });
    }

    // Bun's S3 writer resolves credentials when the client is constructed. With
    // none resolvable it does not fail: `end()` returns 0 and the object is
    // simply never uploaded. Verified against the installed runtime. A silent
    // no-op would be the worst possible outcome here — the board would commit an
    // attachment whose bytes do not exist — so the object is confirmed instead
    // of trusted.
    const stored = await this.stat(key);
    if (stored === null) {
      throw new BlobStoreError(
        "IO",
        `failed to write blob: ${key} (the object is absent after upload; check S3 credentials)`,
      );
    }
    if (stored.size !== written) {
      throw new BlobStoreError("IO", `failed to write blob: ${key} (stored ${stored.size} of ${written} bytes)`);
    }
  }

  async open(key: string, range?: BlobRange): Promise<OpenedBlob | null> {
    const target = this.client.file(this.objectKey(key));
    let info: Awaited<ReturnType<typeof target.stat>>;
    try {
      info = await target.stat();
    } catch (error) {
      if (isMissing(error)) return null;
      throw new BlobStoreError("IO", `failed to read blob: ${key}`, { cause: error });
    }
    const size = info.size;

    if (range !== undefined && (range.start < 0 || range.endInclusive < range.start || range.start >= size)) {
      throw new BlobStoreError("IO", `unsatisfiable range for blob: ${key}`);
    }
    // Blob.slice's end is exclusive, while our range is inclusive; the ranged
    // GET happens when the returned stream is read.
    const sliced = range === undefined ? target : target.slice(range.start, range.endInclusive + 1);
    try {
      return { body: sliced.stream(), size };
    } catch (error) {
      throw new BlobStoreError("IO", `failed to stream blob: ${key}`, { cause: error });
    }
  }

  async stat(key: string): Promise<BlobStat | null> {
    const target = this.client.file(this.objectKey(key));
    try {
      const info = await target.stat();
      return { size: info.size };
    } catch (error) {
      if (isMissing(error)) return null;
      throw new BlobStoreError("IO", `failed to stat blob: ${key}`, { cause: error });
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.client.file(this.objectKey(key));
    try {
      // S3 delete is idempotent for a missing key, which is the contract.
      await target.delete();
    } catch (error) {
      if (isMissing(error)) return;
      throw new BlobStoreError("IO", `failed to delete blob: ${key}`, { cause: error });
    }
  }

  async *listKeys(prefix = ""): AsyncIterable<string> {
    const fullPrefix = `${this.prefix}${prefix}`;
    let startAfter: string | undefined;
    for (;;) {
      let page: S3ListPage;
      try {
        page = await this.listPage({
          prefix: fullPrefix,
          maxKeys: 1000,
          ...(startAfter !== undefined ? { startAfter } : {}),
        });
      } catch (error) {
        throw new BlobStoreError("IO", "failed to list blobs", { cause: error });
      }
      const contents = page.contents ?? [];
      for (const object of contents) {
        const key = object.key;
        if (key === undefined) continue;
        yield this.stripPrefix(key);
      }
      if (page.isTruncated !== true || contents.length === 0) return;
      startAfter = contents[contents.length - 1]?.key;
      if (startAfter === undefined) return;
    }
  }

  /**
   * `S3Client.list` exists on the installed runtime (verified) but is missing
   * from the bundled Bun type definitions, so the gap is declared once here
   * instead of casting at each call. Replace with the typed call once the
   * types catch up.
   */
  private listPage(options: S3ListOptions): Promise<S3ListPage> {
    const list = (this.client as unknown as { list(input: S3ListOptions): Promise<S3ListPage> }).list;
    return list.call(this.client, options);
  }

  private objectKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  private stripPrefix(key: string): string {
    return this.prefix !== "" && key.startsWith(this.prefix) ? key.slice(this.prefix.length) : key;
  }

  private async exists(file: { exists(): Promise<boolean> }): Promise<boolean> {
    try {
      return await file.exists();
    } catch (error) {
      throw new BlobStoreError("IO", "failed to check whether a blob exists", { cause: error });
    }
  }
}

/** Arguments for one listing page. */
interface S3ListOptions {
  readonly prefix: string;
  readonly maxKeys: number;
  readonly startAfter?: string;
}

/** One page of an S3 listing, as the runtime returns it. */
interface S3ListPage {
  readonly contents?: ReadonlyArray<{ readonly key?: string }>;
  readonly isTruncated?: boolean;
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+/, "");
  return trimmed === "" || trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/** Bun raises `S3Error` for a service-side failure; a missing key is a 404. */
function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { name?: string; code?: string; status?: number; message?: string };
  if (record.status === 404) return true;
  if (record.code === "NoSuchKey" || record.code === "NotFound") return true;
  return record.name === "S3Error" && record.code === "NoSuchKey";
}
