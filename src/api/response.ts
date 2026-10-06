// Response conventions (docs/plans/main-product-implementation.md §7 Task 8):
// success: { "data": ..., "meta": ... } — error: { "error": { code, message, details? } }
// Every response carries a correlation ID in x-request-id.
import { WorkboardError, type WorkboardErrorCode } from "../domain/errors";
import { PayloadTooLargeError, ValidationError } from "../domain/errors";
import { boundedDiagnostic } from "../observability/diagnostic";
import type { StreamedUpload } from "../app/attachment-support";

const STATUS_BY_CODE: Record<WorkboardErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL: 500,
};

export function jsonSuccess(
  data: unknown,
  meta: Record<string, unknown> | undefined,
  requestId: string,
  status = 200,
): Response {
  const body = meta === undefined ? { data } : { data, meta };
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders(requestId),
  });
}

export function jsonError(
  code: WorkboardErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
): Response {
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) error.details = details;
  return new Response(JSON.stringify({ error }), {
    status: STATUS_BY_CODE[code],
    headers: jsonHeaders(requestId),
  });
}

export function mapError(error: unknown, requestId: string): Response {
  return mapErrorWithReport(error, requestId, reportUnexpectedError);
}

/**
 * Error mapping with the unexpected-failure report injected, so a caller that
 * owns an observability sink can report through it instead of process-wide
 * stderr. A WorkboardError is an expected, documented outcome: it is never
 * reported anywhere.
 */
export function mapErrorWithReport(
  error: unknown,
  requestId: string,
  report: (error: unknown, requestId: string) => void,
): Response {
  if (error instanceof WorkboardError) {
    return jsonError(error.code, error.message, requestId, error.details);
  }
  report(error, requestId);
  return jsonError("INTERNAL", "An internal error occurred.", requestId);
}

/**
 * Report an unhandled failure. The request id is always recorded so a client's
 * correlation id can be matched to the log line; the exception itself is
 * reduced to a bounded class-name-and-message diagnostic, never a stack and
 * never the raw object, because either can carry request-derived material.
 */
export function reportUnexpectedError(error: unknown, requestId: string): void {
  console.error(`[api] unhandled error (request ${boundedRequestId(requestId)}): ${boundedDiagnostic(error)}`);
}

function boundedRequestId(requestId: string): string {
  return requestId.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 128);
}

/** Neutral report: records nothing. Used when a sink takes over the failure record. */
export function discardUnexpectedError(): void {}

export function methodNotAllowed(allow: readonly string[], requestId: string): Response {
  const response = jsonError("METHOD_NOT_ALLOWED", "The HTTP method is not allowed for this path.", requestId);
  response.headers.set("Allow", allow.join(", "));
  return response;
}

function jsonHeaders(requestId: string): Headers {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  headers.set("X-Request-Id", requestId);
  return headers;
}

/**
 * Reads the request body as UTF-8 text with a hard byte cap enforced while
 * streaming. Unlike a bare `request.text()`, an oversized or lying
 * content-length body never gets fully buffered: the read aborts as soon as
 * the running total exceeds maxBytes (413 to the caller via WorkboardError).
 */
export async function readBodyText(request: Request, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new PayloadTooLargeError();
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  const chunks: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("payload too large").catch(() => {});
        throw new PayloadTooLargeError();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return chunks.join("");
}

/**
 * Parses a JSON request body with a hard size bound. Oversized, empty, and
 * malformed bodies map to stable WorkboardErrors (413/400).
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const text = await readBodyText(request, maxBytes);
  if (text.trim().length === 0) {
    throw new ValidationError("A JSON request body is required.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("Malformed JSON body.");
  }
}

/** The API produces the application-owned streamed upload contract. */
export type { StreamedUpload } from "../app/attachment-support";

/**
 * Streams a request body to a consumer with a hard byte cap, without ever
 * buffering the whole body.
 *
 * `readBodyText` deliberately accumulates (it must, to produce a string); a
 * video upload cannot. This hands the caller a stream it forwards to storage
 * while watching the running total, so the cap is enforced by cancelling
 * mid-flight: an oversized or lying `content-length` costs a bounded number of
 * bytes rather than a full buffer.
 *
 * The prefix resolution is the sequencing point that makes the upload safe:
 * the caller awaits `prefix`, decides whether the declared media type is
 * believable, and only then lets storage consume `body`.
 */
export function streamBody(
  request: Request,
  maxBytes: number,
  prefixBytes: number,
): StreamedUpload {
  const declaredHeader = request.headers.get("content-length");
  const declared = Number(declaredHeader ?? "");
  if (declaredHeader !== null && Number.isFinite(declared) && declared > maxBytes) {
    throw new PayloadTooLargeError();
  }
  const source = request.body;
  if (source === null) {
    throw new ValidationError("A request body is required.");
  }

  const prefixChunks: Uint8Array[] = [];
  let prefixLength = 0;
  let prefixSettled = false;
  let capturePrefix: (bytes: Uint8Array) => void = () => {};
  let failPrefix: (error: unknown) => void = () => {};
  const prefix = new Promise<Uint8Array>((resolve, reject) => {
    capturePrefix = resolve;
    failPrefix = reject;
  });
  // The caller may reject the upload (a lying content-type) without ever
  // consuming the body; that rejection must not surface as an unhandled one.
  prefix.catch(() => {});

  let total = 0;
  let settled = false;
  let resolveFinished: () => void = () => {};
  let rejectFinished: (error: unknown) => void = () => {};
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  finished.catch(() => {});

  // One read path, no concurrency. `prime` and the body's `pull` both need bytes
  // from the same reader, and two overlapping `read()` calls on one reader lose
  // chunks between them. Rather than coordinate two readers with flags and
  // waiters — which produced a subtle race three times over — every read goes
  // through this single async function, whose result is consumed in turn.
  const reader = source.getReader();
  let readDone = false;

  /** Read the next chunk, or record exhaustion/failure. Never called twice at once. */
  const nextChunk = async (): Promise<PendingChunk> => {
    if (readDone) return { done: true };
    try {
      const { done, value } = await reader.read();
      if (done) {
        readDone = true;
        return { done: true };
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("payload too large").catch(() => {});
        readDone = true;
        return { error: new PayloadTooLargeError() };
      }
      return { value };
    } catch (error) {
      readDone = true;
      return { error };
    }
  };

  /**
   * Read ahead until enough leading bytes exist to sniff, before anyone
   * consumes `body`.
   *
   * This is what makes the prefix usable: the caller must validate the media
   * type before storing anything, but a stream only produces bytes when pulled.
   * Waiting for a consumer to fill the prefix would deadlock, and reading in
   * parallel with that consumer loses data. So this loop reads, buffers into
   * `pending`, and stops the moment the prefix is settled; the body then drains
   * `pending` before reading more.
   */
  // Chunks read while filling the prefix, handed to the body in order.
  const pending: PendingChunk[] = [];

  /**
   * Read ahead until enough leading bytes exist to sniff, before anyone
   * consumes `body`.
   *
   * This is what makes the prefix usable: the caller must validate the media
   * type before storing anything, but a stream only produces bytes when pulled.
   * Waiting for a consumer to fill the prefix would deadlock, so this loop
   * reads and buffers; the body then delivers what was buffered before reading
   * more.
   */
  const prime = (async () => {
    try {
      while (!prefixSettled) {
        const chunk = await nextChunk();
        pending.push(chunk);
        if (chunk.error !== undefined) {
          prefixSettled = true;
          failPrefix(chunk.error);
          return;
        }
        if (chunk.done === true) {
          prefixSettled = true;
          capturePrefix(joinPrefix(prefixChunks, prefixLength));
          return;
        }
        const value = chunk.value as Uint8Array;
        const take = Math.min(prefixBytes - prefixLength, value.byteLength);
        if (take > 0) {
          prefixChunks.push(value.subarray(0, take));
          prefixLength += take;
        }
        if (prefixLength >= prefixBytes) {
          prefixSettled = true;
          capturePrefix(joinPrefix(prefixChunks, prefixLength));
        }
      }
    } catch (error) {
      prefixSettled = true;
      failPrefix(error);
    }
  })();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Wait for priming to finish first. Pulling while `prime` is mid-read
        // would call `nextChunk` concurrently with it, which is exactly the
        // overlap this design removes.
        await prime;
        const next = pending.length > 0 ? (pending.shift() as PendingChunk) : await nextChunk();
        if (next.done === true) {
          controller.close();
          settleFinished();
          return;
        }
        if (next.error !== undefined) {
          controller.error(next.error);
          settleFinished(next.error);
          return;
        }
        controller.enqueue(next.value as Uint8Array);
      } catch (error) {
        controller.error(error);
        settleFinished(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      settleFinished(new Error("upload cancelled"));
    },
  });

  function settleFinished(error?: unknown): void {
    if (settled) return;
    settled = true;
    if (error === undefined) resolveFinished();
    else rejectFinished(error);
  }

  void prime;
  return { body, prefix, finished, declaredBytes: Number.isFinite(declared) && declaredHeader !== null ? declared : null };
}

/** One read-ahead result, or the terminal/error marker for it. */
interface PendingChunk {
  readonly value?: Uint8Array;
  readonly done?: true;
  readonly error?: unknown;
}

function joinPrefix(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
