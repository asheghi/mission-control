import type { Database } from "bun:sqlite";
import type { Clock } from "../domain/types";
import { systemClock } from "../domain/types";
import {
  clearBlobDeletion,
  deletePendingAttachment,
  listBlobDeletions,
  listPendingAttachments,
  recordBlobDeletionFailure,
} from "../db/repositories/attachments";
import { DEFAULT_BLOB_DELETION_BATCH, DEFAULT_PENDING_GRACE_MS, MAX_DRAIN_ATTEMPTS } from "./attachment-support";
import { boundedDiagnostic } from "../observability/diagnostic";
import type { BlobStore } from "../storage/types";

export interface AttachmentMaintenanceOptions {
  readonly db: Database;
  readonly blobs?: BlobStore;
  readonly clock?: Clock;
  readonly blobDeletionBatch?: number;
  readonly activeUploads: ReadonlySet<number>;
}

/** Owns bounded attachment cleanup while the service retains its public API. */
export class AttachmentMaintenance {
  private readonly db: Database;
  private readonly blobs: BlobStore | undefined;
  private readonly clock: Clock;
  private readonly blobDeletionBatch: number;
  private readonly activeUploads: ReadonlySet<number>;
  private draining: Promise<{ deleted: number; failed: number }> | null = null;

  constructor(options: AttachmentMaintenanceOptions) {
    this.db = options.db;
    this.blobs = options.blobs;
    this.clock = options.clock ?? systemClock;
    this.blobDeletionBatch = options.blobDeletionBatch ?? DEFAULT_BLOB_DELETION_BATCH;
    this.activeUploads = options.activeUploads;
  }

  async drainBlobDeletions(): Promise<{ deleted: number; failed: number }> {
    const blobs = this.blobs;
    if (blobs === undefined) return { deleted: 0, failed: 0 };
    if (this.draining !== null) return this.draining;
    this.draining = this.runDrain(blobs).finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async runDrain(blobs: BlobStore): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;
    for (;;) {
      const pending = listBlobDeletions(this.db, this.blobDeletionBatch);
      if (pending.length === 0) break;
      let progressed = false;
      for (const entry of pending) {
        try {
          await blobs.delete(entry.storage_key);
          clearBlobDeletion(this.db, entry.storage_key);
          deleted += 1;
          progressed = true;
        } catch (error) {
          recordBlobDeletionFailure(this.db, entry.storage_key, boundedDiagnostic(error));
          failed += 1;
        }
      }
      if (!progressed) break;
      if (deleted + failed > MAX_DRAIN_ATTEMPTS) break;
    }
    return { deleted, failed };
  }

  async sweepPendingAttachments(options: { readonly graceMs?: number } = {}): Promise<{ removed: number }> {
    const graceMs = options.graceMs ?? DEFAULT_PENDING_GRACE_MS;
    const cutoff = new Date(Date.parse(this.clock.now()) - graceMs).toISOString();
    const stale = listPendingAttachments(this.db).filter(
      (row) => row.created_at < cutoff && !this.activeUploads.has(row.id),
    );
    for (const row of stale) deletePendingAttachment(this.db, row.id);
    if (stale.length > 0) await this.drainBlobDeletions();
    return { removed: stale.length };
  }
}
