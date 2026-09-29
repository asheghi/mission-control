// Attachment upload for the detail view.
//
// Uploads are per-file requests with bounded concurrency, not one batch: a
// dropped folder of screenshots should show progress per file, fail per file,
// and not have one bad file cancel the rest. Progress needs XMLHttpRequest,
// which is why the client function uses it rather than fetch.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import * as api from "../../api.js";

/**
 * Concurrent uploads are capped well below what a browser would allow.
 *
 * Each upload holds a stream open on the server and a connection in the
 * browser, and the board is backed by one SQLite file. Four keeps a batch
 * visibly parallel without turning a drop of thirty files into thirty
 * simultaneous writes.
 */
export const MAX_CONCURRENT_UPLOADS = 4;

export const ATTACHMENT_MAX_BYTES = { image: 20 * 1024 * 1024, video: 250 * 1024 * 1024 } as const;

export const ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm";

/** The server's allowlist, mirrored so a doomed upload is refused instantly. */
const ACCEPTED_TYPES = new Set(ATTACHMENT_ACCEPT.split(","));

export interface UploadItem {
  readonly id: string;
  readonly filename: string;
  readonly loaded: number;
  readonly total: number;
  readonly state: "queued" | "uploading" | "failed" | "done";
  readonly error: string;
}

/** One uploaded file and the attachment it became. */
export interface UploadedAttachment {
  readonly file: File;
  readonly id: number;
}

export interface AttachmentUploadState {
  readonly uploads: readonly UploadItem[];
  /** True while any upload is queued or in flight. */
  readonly busy: boolean;
  /** A message safe to show; empty when there is nothing to say. */
  readonly notice: string;
  readonly dismissNotice: () => void;
  /**
   * Upload files to an item. Resolves once every upload has settled, with each
   * successful file paired to the attachment it became.
   *
   * The pairing is by file, not by position: uploads finish out of order, so a
   * positional array would label a fast file with a slow file's attachment id —
   * and a failed upload would shift every later reference.
   */
  readonly uploadFiles: (itemId: number, files: readonly File[]) => Promise<readonly UploadedAttachment[]>;
  /** Files this build will accept, with a reason for each refusal. */
  readonly rejectUnsupported: (files: readonly File[]) => { accepted: File[]; rejected: string[] };
}

/**
 * The largest size allowed for a file, by the type the browser reports.
 *
 * This mirrors the server's caps so a doomed upload is refused before it starts.
 * The server remains authoritative: it re-checks the declared type against the
 * bytes and enforces the cap while streaming, so a client that lies here only
 * wastes its own bandwidth.
 */
export function maxBytesForFile(file: File): number | null {
  // An explicit list, not a prefix test. `image/svg+xml` starts with `image/`
  // and is deliberately refused by the server — treating it as an image here
  // would send a file the client had already promised would work, and the user
  // would learn about it from a server error instead of instantly.
  if (ACCEPTED_TYPES.has(file.type)) {
    return file.type.startsWith("video/") ? ATTACHMENT_MAX_BYTES.video : ATTACHMENT_MAX_BYTES.image;
  }
  return null;
}

/** A short, human-readable size, for progress and error text. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function useAttachmentUpload(onUploaded: () => void): AttachmentUploadState {
  const [uploads, setUploads] = useState<readonly UploadItem[]>([]);
  const [notice, setNotice] = useState("");
  const mountedRef = useRef(true);
  /**
   * Every in-flight request, so unmount can actually cancel them.
   *
   * Dropping state updates is not enough: an aborted page would otherwise keep
   * streaming megabytes to the server for a view nobody is looking at.
   */
  const controllersRef = useRef(new Set<AbortController>());
  /**
   * The hook's single pool of upload slots.
   *
   * It lives on the hook, not inside one `uploadFiles` call: a paste, a drop,
   * and a file-picker selection started close together each used to build their
   * own four workers, so the documented limit of four could be exceeded three
   * times over. Callers now take a slot before starting an upload and return it
   * when that upload settles.
   */
  const slotsRef = useRef<{ active: number; waiting: Array<() => void> }>({ active: 0, waiting: [] });
  const uploadedRef = useRef(onUploaded);
  uploadedRef.current = onUploaded;

  useEffect(
    () => () => {
      mountedRef.current = false;
      for (const controller of controllersRef.current) controller.abort();
      controllersRef.current.clear();
      // Object URLs outlive a component unless they are released; a sign-out
      // must not leave decoded media reachable.
      api.releaseAllAttachmentObjectUrls();
    },
    [],
  );

  /**
   * Take one of the shared upload slots, waiting if all are busy.
   *
   * A waiter is resolved by `releaseSlot` handing its slot over, so this
   * increments the count only on the immediate path. Incrementing after the
   * await would double-count: the released slot could be taken by a third
   * caller in the gap before this one woke, pushing the total past the bound.
   */
  const acquireSlot = useCallback(async (): Promise<void> => {
    const slots = slotsRef.current;
    if (slots.active < MAX_CONCURRENT_UPLOADS) {
      slots.active += 1;
      return;
    }
    await new Promise<void>((resolve) => slots.waiting.push(resolve));
    // The slot is already counted: it was transferred, not re-acquired.
  }, []);

  /**
   * Return a slot, transferring it to the next waiter if there is one.
   *
   * Transferring rather than decrement-then-wake is what keeps the bound exact:
   * a decrement is visible to every other caller, so a third upload could take
   * the freed slot while the woken waiter also claimed it.
   */
  const releaseSlot = useCallback((): void => {
    const slots = slotsRef.current;
    const next = slots.waiting.shift();
    if (next !== undefined) {
      // The slot never becomes free: it changes hands.
      next();
      return;
    }
    slots.active = Math.max(0, slots.active - 1);
  }, []);

  const update = useCallback((id: string, patch: Partial<UploadItem>) => {
    setUploads((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const uploadFiles = useCallback(
    async (itemId: number, files: readonly File[]): Promise<readonly UploadedAttachment[]> => {
      const { accepted, rejected } = rejectUnsupported(files);
      if (rejected.length > 0) {
        setNotice(rejected.join(" "));
      } else {
        setNotice("");
      }
      if (accepted.length === 0) return [];

      // Seed every entry as queued so the UI shows the whole batch immediately,
      // then run them through a small worker pool.
      const queued: UploadItem[] = accepted.map((file) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        filename: file.name || "attachment",
        loaded: 0,
        total: file.size,
        state: "queued" as const,
        error: "",
      }));
      setUploads((current) => [...current, ...queued]);

      // Results are written by source index, so a file's attachment id is
      // recorded against that file regardless of the order uploads complete in.
      const results: Array<UploadedAttachment | null> = queued.map(() => null);
      let cursor = 0;
      const runOne = async (index: number): Promise<void> => {
        const entry = queued[index];
        const file = accepted[index];
        if (entry === undefined || file === undefined) return;
        if (!mountedRef.current) return;
        update(entry.id, { state: "uploading" });
        const controller = new AbortController();
        controllersRef.current.add(controller);
        try {
          const attachment = await api.uploadItemAttachment(itemId, file, {
            signal: controller.signal,
            onProgress: (progress: { loaded: number; total: number }) =>
              update(entry.id, { loaded: progress.loaded, total: progress.total }),
          });
          if (!mountedRef.current) return;
          results[index] = { file, id: attachment.id };
          update(entry.id, { state: "done", loaded: file.size, total: file.size });
        } catch (error) {
          if (!mountedRef.current) return;
          update(entry.id, {
            state: "failed",
            error: error instanceof Error ? error.message : "The upload failed.",
          });
        } finally {
          controllersRef.current.delete(controller);
        }
      };

      // Every queued file goes through the hook's shared slots, so several
      // batches started close together cannot each open their own set of
      // uploads and exceed the bound between them.
      const workers = Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, queued.length) }, async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= queued.length) return;
          if (!mountedRef.current) return;
          await acquireSlot();
          try {
            if (!mountedRef.current) return;
            await runOne(index);
          } finally {
            releaseSlot();
          }
        }
      });
      await Promise.all(workers);
      const uploaded = results.filter((entry): entry is UploadedAttachment => entry !== null);
      if (!mountedRef.current) return uploaded;
      uploadedRef.current();
      return uploaded;
    },
    [acquireSlot, releaseSlot, update],
  );

  const busy = uploads.some((item) => item.state === "queued" || item.state === "uploading");

  // Settled uploads are cleared once nothing is in flight, so the panel does
  // not accumulate a row per file for the life of the page. Failures stay
  // visible until the user dismisses them.
  useEffect(() => {
    if (busy) return;
    const timer = setTimeout(() => {
      setUploads((current) => current.filter((item) => item.state === "failed"));
    }, 4000);
    return () => clearTimeout(timer);
  }, [busy]);

  return {
    uploads,
    busy,
    notice,
    dismissNotice: () => setNotice(""),
    uploadFiles,
    rejectUnsupported,
  };
}

/** Split a selection into what this build can send and what it cannot. */
export function rejectUnsupported(files: readonly File[]): { accepted: File[]; rejected: string[] } {
  const accepted: File[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    const max = maxBytesForFile(file);
    if (max === null) {
      rejected.push(`${file.name || "A file"} is not an accepted image or video (png, jpeg, webp, gif, mp4, webm).`);
      continue;
    }
    if (file.size === 0) {
      rejected.push(`${file.name || "A file"} is empty.`);
      continue;
    }
    if (file.size > max) {
      rejected.push(`${file.name || "A file"} is larger than ${formatBytes(max)}.`);
      continue;
    }
    accepted.push(file);
  }
  return { accepted, rejected };
}

/** Files carried by a paste or drop, ignoring everything else. */
export function filesFromDataTransfer(transfer: DataTransfer | null): File[] {
  if (transfer === null) return [];
  const out: File[] = [];
  if (transfer.files && transfer.files.length > 0) {
    for (const file of Array.from(transfer.files)) out.push(file);
    return out;
  }
  // Some sources expose dropped media only through `items`.
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file !== null) out.push(file);
  }
  return out;
}
