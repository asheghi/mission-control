// The blob storage boundary.
//
// A BlobStore holds immutable, opaque byte objects addressed by a key the
// caller owns. Deliberately narrow: it knows nothing about work items,
// participants, media types, or size policy — those are product decisions that
// belong to the domain and the application service. It also leaks no backend
// concept: no filesystem path, no bucket, no ETag, and no presigned URL, so the
// same callers work against a directory and against S3.
//
// Every operation is streaming. A 250 MiB video must upload and download with
// bounded memory, which rules out any method that returns buffered bytes.

/** One byte range, inclusive on both ends, as HTTP spells it. */
export interface BlobRange {
  readonly start: number;
  readonly endInclusive: number;
}

export interface BlobStat {
  readonly size: number;
}

export interface OpenedBlob {
  readonly body: ReadableStream<Uint8Array>;
  /** Size of the whole object, not of the returned range. */
  readonly size: number;
}

/**
 * Backend failures, kept small on purpose. `NOT_FOUND` is an ordinary absence;
 * `ALREADY_EXISTS` is a violated create-if-absent precondition; everything else
 * is `IO`. Messages here may carry backend detail (a path, an S3 error code) —
 * `WorkboardService` is responsible for never letting that reach a caller.
 */
export type BlobStoreErrorCode = "NOT_FOUND" | "ALREADY_EXISTS" | "IO";

export class BlobStoreError extends Error {
  constructor(
    public readonly code: BlobStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface PutOptions {
  /**
   * Refuse to replace an existing object. Keys are random and row-owned, so a
   * collision means a bug or a retry: silently overwriting could destroy
   * another attachment's bytes.
   */
  readonly ifAbsent?: boolean;
}

export interface BlobStore {
  /**
   * Store `body` under `key`. The stream is consumed exactly once and must not
   * be buffered by the implementation.
   */
  put(key: string, body: ReadableStream<Uint8Array>, options?: PutOptions): Promise<void>;

  /**
   * Open `key` for reading, optionally restricted to one range. Resolves null
   * when the object is absent. An unsatisfiable range throws `IO` rather than
   * returning a short read, so a caller cannot mistake it for success.
   */
  open(key: string, range?: BlobRange): Promise<OpenedBlob | null>;

  /** Size of `key`, or null when absent. */
  stat(key: string): Promise<BlobStat | null>;

  /** Remove `key`. Succeeds when the object is already absent. */
  delete(key: string): Promise<void>;

  /**
   * Enumerate stored keys, oldest-first ordering unspecified. Maintenance only
   * (orphan scans, byte totals) — never used on a request path.
   */
  listKeys(prefix?: string): AsyncIterable<string>;
}
