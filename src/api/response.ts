// Response conventions (docs/plans/main-product-implementation.md §7 Task 8):
// success: { "data": ..., "meta": ... } — error: { "error": { code, message, details? } }
// Every response carries a correlation ID in x-request-id.
import { WorkboardError, type WorkboardErrorCode } from "../domain/errors";
import { PayloadTooLargeError, ValidationError } from "../domain/errors";

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
 * Report an unhandled failure without collecting the exception. Messages and
 * stacks can contain request bodies, item content, or credentials, so the log
 * record is deliberately fixed and includes only the validated request id.
 */
export function reportUnexpectedError(_error: unknown, requestId: string): void {
  console.error(`[api] unhandled error (request ${boundedRequestId(requestId)})`);
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
