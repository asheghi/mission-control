import type { Database } from "bun:sqlite";
import { z } from "zod";
import { positiveIdSchema } from "../domain/validation";
import { clearBlobDeletion } from "../db/repositories/attachments";
import type { BlobStore } from "../storage/types";

/** Transport-neutral streamed bytes with bounded delivery and signature evidence. */
export interface StreamedUpload {
  readonly body: ReadableStream<Uint8Array>;
  readonly prefix: Promise<Uint8Array>;
  readonly finished: Promise<void>;
  readonly declaredBytes: number | null;
}

/**
 * Exactly one parent. A file belongs to an item or to a comment; the database
 * CHECK is the authority, and this rejects the ambiguity earlier with a better
 * message than a constraint error.
 */
export const attachmentTargetSchema = z
  .strictObject({
    itemId: positiveIdSchema.optional(),
    commentId: positiveIdSchema.optional(),
  })
  .refine((value) => (value.itemId === undefined) !== (value.commentId === undefined), {
    message: "Provide exactly one of itemId or commentId.",
  });

export type AttachmentTarget = z.infer<typeof attachmentTargetSchema>;

/** A streamed body plus everything needed to place it, supplied by a transport. */
export interface UploadAttachmentInput extends AttachmentTarget {
  /** The client's claim. Verified against sniffed bytes, never trusted. */
  readonly declaredMediaType: string;
  /** Display name only; sanitized before it is stored. */
  readonly filename: string | null;
  readonly body: StreamedUpload;
}

export const DEFAULT_BLOB_DELETION_BATCH = 50;

/**
 * Ceiling on one drain pass, so a board with thousands of stranded keys cannot
 * turn a single request or startup into an unbounded loop.
 */
export const MAX_DRAIN_ATTEMPTS = 10_000;

/** How long a `pending` upload may sit before a sweep treats it as abandoned. */
export const DEFAULT_PENDING_GRACE_MS = 15 * 60 * 1000;

/** An error and everything it wraps, outermost first, bounded against cycles. */
export function* causeChain(error: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) return;
    seen.add(current);
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * Delete an object that a failed upload may have written, and retire its
 * durable deletion record only if the bytes are confirmed gone.
 *
 * The distinction matters: `clearBlobDeletion` on an object that still exists
 * erases the only record of it, so nothing would ever retry and the bytes would
 * leak permanently. Leaving the row is harmless — the next drain finds the
 * object already absent and clears it then.
 */
export async function discardBlob(blobs: BlobStore, db: Database, storageKey: string): Promise<void> {
  try {
    await blobs.delete(storageKey);
    clearBlobDeletion(db, storageKey);
  } catch {
    // Deliberately not cleared: the queue row is the retry.
  }
}

/**
 * Abandon an upload whose bytes are no longer wanted.
 *
 * A request body that is neither consumed nor cancelled holds its connection
 * open, which turns a refused upload into a hang. Cancelling settles both the
 * transport and the `finished` promise, so the failure surfaces immediately.
 */
export async function cancelUpload(body: StreamedUpload): Promise<void> {
  await body.body.cancel("upload rejected").catch(() => {});
  await body.finished.catch(() => {});
}
