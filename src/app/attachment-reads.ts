import type { Database } from "bun:sqlite";
import { BlobStoreError, type BlobRange, type BlobStore } from "../storage/types";
import { ConflictError, InternalError, NotFoundError, PayloadTooLargeError, WorkboardError } from "../domain/errors";
import { positiveIdSchema, parseInput } from "../domain/validation";
import {
  getAttachmentById,
  getAttachmentRowById,
  listCommentAttachments as listCommentAttachmentRows,
  listItemAttachments as listItemAttachmentRows,
} from "../db/repositories/attachments";
import { getCommentById } from "../db/repositories/comments";
import { getItemById } from "../db/repositories/items";
import { toAttachmentDto, type AttachmentDto } from "./dto";
import { causeChain } from "./attachment-support";

export function listItemAttachments(db: Database, itemId: number): readonly AttachmentDto[] {
  parseInput(positiveIdSchema, itemId);
  if (getItemById(db, itemId) === null) throw new NotFoundError("item", itemId);
  return listItemAttachmentRows(db, itemId).map(toAttachmentDto);
}

export function listCommentAttachments(db: Database, commentId: number): readonly AttachmentDto[] {
  parseInput(positiveIdSchema, commentId);
  if (getCommentById(db, commentId) === null) throw new NotFoundError("comment", commentId);
  return listCommentAttachmentRows(db, commentId).map(toAttachmentDto);
}

export function getAttachment(db: Database, attachmentId: number): AttachmentDto {
  parseInput(positiveIdSchema, attachmentId);
  const row = getAttachmentById(db, attachmentId);
  if (row === null) throw new NotFoundError("attachment", attachmentId);
  return toAttachmentDto(row);
}

export async function openAttachment(
  db: Database,
  blobs: BlobStore | undefined,
  attachmentId: number,
  range?: BlobRange,
): Promise<{ attachment: AttachmentDto; body: ReadableStream<Uint8Array>; size: number; mediaType: string }> {
  const attachment = getAttachment(db, attachmentId);
  const row = getAttachmentRowById(db, attachmentId);
  if (row === null) throw new NotFoundError("attachment", attachmentId);
  if (blobs === undefined) throw new ConflictError("No attachment storage is configured for this board.");
  const opened = await openBlob(blobs, row.storage_key, range);
  return { attachment, body: opened.body, size: opened.size, mediaType: row.media_type };
}

export async function openBlob(blobs: BlobStore, storageKey: string, range?: BlobRange) {
  try {
    const opened = await blobs.open(storageKey, range);
    if (opened === null) throw new InternalError("The stored file for this attachment is missing.");
    return opened;
  } catch (error) {
    throw mapBlobError(error, "read the attachment");
  }
}

export function mapBlobError(error: unknown, action: string): Error {
  for (const candidate of causeChain(error)) {
    if (candidate instanceof PayloadTooLargeError) return candidate;
    if (candidate instanceof WorkboardError) return candidate;
    if (candidate instanceof BlobStoreError && candidate.code === "ALREADY_EXISTS") {
      return new ConflictError("That file already exists in storage.");
    }
  }
  return new InternalError(`Failed to ${action}.`, { cause: error });
}
