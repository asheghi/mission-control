import type { Database } from "bun:sqlite";
import { ConflictError, NotFoundError, PayloadTooLargeError, ValidationError } from "../domain/errors";
import type { Actor, Clock } from "../domain/types";
import {
  assertMediaTypeMatches,
  generateStorageKey,
  maxBytesFor,
  sanitizeFilename,
  type AttachmentMediaType,
} from "../domain/attachments";
import { commitAttachment, createPendingAttachment, deletePendingAttachment, getAttachmentById } from "../db/repositories/attachments";
import { getCommentById } from "../db/repositories/comments";
import { getItemById } from "../db/repositories/items";
import { toAttachmentDto, type AttachmentDto } from "./dto";
import { attachmentTargetSchema, cancelUpload, discardBlob, type UploadAttachmentInput } from "./attachment-support";
import { parseInput } from "../domain/validation";
import type { BlobStore } from "../storage/types";
import type { EventPublisher } from "./events";
import { mapBlobError } from "./attachment-reads";

export interface AttachmentUploadDependencies {
  readonly db: Database;
  readonly clock: Clock;
  readonly events: EventPublisher | undefined;
  readonly blobs: BlobStore | undefined;
  readonly activeUploads: Set<number>;
}

export async function uploadAttachment(
  dependencies: AttachmentUploadDependencies,
  actor: Actor,
  input: UploadAttachmentInput,
): Promise<AttachmentDto> {
  const { db, clock, events, activeUploads } = dependencies;
  const blobs = dependencies.blobs;
  if (blobs === undefined) {
    throw new ConflictError("No attachment storage is configured for this board.");
  }
  // Pick the target keys explicitly: the rest of `input` (the stream, the
  // declared type) is not part of the strict target schema and must not be
  // parsed by it.
  const target = parseInput(attachmentTargetSchema, {
    ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
    ...(input.commentId !== undefined ? { commentId: input.commentId } : {}),
  });
  if (target.itemId !== undefined && getItemById(db, target.itemId) === null) {
    throw new NotFoundError("item", target.itemId);
  }
  if (target.commentId !== undefined && getCommentById(db, target.commentId) === null) {
    throw new NotFoundError("comment", target.commentId);
  }

  // Sniff first: reading just the prefix decides whether this is even an
  // acceptable upload, before a single byte is written anywhere.
  //
  // Every early rejection below abandons a request body still being sent.
  // Cancelling it is not tidiness: an undrained body keeps its connection
  // alive, so a refused upload would hang the caller instead of failing fast.
  const prefix = await input.body.prefix;
  let mediaType: AttachmentMediaType;
  try {
    mediaType = assertMediaTypeMatches(input.declaredMediaType, prefix);
  } catch (error) {
    await cancelUpload(input.body);
    throw error;
  }
  if (mediaType !== input.declaredMediaType.split(";")[0]?.trim().toLowerCase()) {
    await cancelUpload(input.body);
    throw new ValidationError("The declared media type does not match the uploaded file.");
  }

  // The per-kind cap is enforced HERE, against the sniffed type, because this
  // is the only place the type is known to be true. A transport can only
  // bound the request by the largest cap of any kind; enforcing the tighter
  // one after sniffing is what makes "20 MiB for images" real rather than
  // documentation. It is re-checked below while the bytes stream, so a body
  // that lies about its length is still stopped mid-flight.
  const effectiveCap = maxBytesFor(mediaType);
  if (input.body.declaredBytes !== null && input.body.declaredBytes > effectiveCap) {
    await cancelUpload(input.body);
    throw new PayloadTooLargeError(
      `A ${mediaType} may be at most ${Math.floor(effectiveCap / (1024 * 1024))} MiB.`,
    );
  }

  const now = clock.now();
  const storageKey = generateStorageKey();
  const filename = sanitizeFilename(input.filename);
  const row = createPendingAttachment(db, {
    itemId: target.itemId ?? null,
    commentId: target.commentId ?? null,
    storageKey,
    filename,
    mediaType,
    createdBy: actor.participantId,
    createdAt: now,
  });

  // Hash what actually arrived rather than trusting the client. The digest is
  // integrity metadata for doctor and backup, never an identity.
  const hasher = new Bun.CryptoHasher("sha256");
  let sizeBytes = 0;
  const counting = input.body.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        sizeBytes += chunk.byteLength;
        // The per-kind cap is enforced on the bytes that actually arrive, not
        // only on the declared length. A client that omits or understates
        // `Content-Length` would otherwise stream a 250 MiB "image" past a
        // 20 MiB limit; this is the check that makes the limit true.
        if (sizeBytes > effectiveCap) {
          controller.error(new PayloadTooLargeError(`A ${mediaType} may be at most ${Math.floor(effectiveCap / (1024 * 1024))} MiB.`));
          return;
        }
        hasher.update(chunk);
        controller.enqueue(chunk);
      },
    }),
  );

  activeUploads.add(row.id);
  try {
    await blobs.put(storageKey, counting, { ifAbsent: true });
    await input.body.finished;
  } catch (error) {
    // Included below: a body that overran its per-kind cap surfaces here as a
    // PayloadTooLargeError from the counting transform, and must not be
    // rewritten into a generic storage failure.
    // The bytes never landed (or landed partially). Drop the reservation and
    // make sure no half-written object survives it.
    deletePendingAttachment(db, row.id);
    // Deleting the pending row queued its key (the trigger fires on every
    // delete). Clearing that entry is only correct once the object is
    // confirmed gone: clearing it unconditionally would discard the retry
    // record for an object that still exists — and a storage backend that
    // wrote bytes before failing would then leave them orphaned forever, with
    // nothing left to find them by.
    await discardBlob(blobs, db, storageKey);
    await cancelUpload(input.body);
    // A per-kind overflow is a client error (413), not a storage fault, so it
    // is passed through instead of being folded into "failed to store".
    if (error instanceof PayloadTooLargeError) throw error;
    throw mapBlobError(error, "store the uploaded file");
  } finally {
    activeUploads.delete(row.id);
  }

  const committed = commitAttachment(db, row.id, {
    sizeBytes,
    sha256: hasher.digest("hex"),
    committedAt: now,
  });
  if (committed === null) {
    // The parent was deleted while the bytes were in flight, so the row is
    // gone and the object is now unreferenced. Remove it rather than leaving
    // an orphan for maintenance to discover; if that removal fails, the queue
    // row stays so a later pass retries it.
    await discardBlob(blobs, db, storageKey);
    throw new ConflictError("The work item or comment this file belongs to was deleted during the upload.");
  }

  // The item id is what a browser needs to know which view is stale. A comment
  // attachment belongs to an item through its comment, so that id is looked up
  // rather than publishing a null — which told every client nothing.
  const owningItemId =
    committed.item_id ?? (committed.comment_id === null ? null : (getCommentById(db, committed.comment_id)?.item_id ?? null));
  events?.publish("attachment.created", owningItemId);
  const joined = getAttachmentById(db, committed.id);
  if (joined === null) throw new NotFoundError("attachment", committed.id);
  return toAttachmentDto(joined);
}
