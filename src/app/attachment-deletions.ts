import type { Database } from "bun:sqlite";
import { NotFoundError } from "../domain/errors";
import { positiveIdSchema, parseInput } from "../domain/validation";
import { getCommentById } from "../db/repositories/comments";
import {
  deleteAttachment as deleteAttachmentRow,
  getAttachmentRowById,
} from "../db/repositories/attachments";
import type { EventPublisher } from "./events";

export async function deleteAttachment(
  db: Database,
  events: EventPublisher | undefined,
  drainBlobDeletions: () => Promise<unknown>,
  attachmentId: number,
): Promise<void> {
  parseInput(positiveIdSchema, attachmentId);
  const row = getAttachmentRowById(db, attachmentId);
  if (row === null) throw new NotFoundError("attachment", attachmentId);
  // Delete the row first; its trigger queues the blob for removal.
  deleteAttachmentRow(db, attachmentId);
  const owningItemId =
    row.item_id ?? (row.comment_id === null ? null : (getCommentById(db, row.comment_id)?.item_id ?? null));
  events?.publish("attachment.deleted", owningItemId);
  // The queue row remains retryable if maintenance cannot remove the blob.
  await drainBlobDeletions();
}
