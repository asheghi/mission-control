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
  if (error instanceof WorkboardError) {
    return jsonError(error.code, error.message, requestId, error.details);
  }
  console.error(`[api] unhandled error (request ${requestId})`, error);
  return jsonError("INTERNAL", "An internal error occurred.", requestId);
}

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
 * Parses a JSON request body with a hard size bound. Oversized, empty, and
 * malformed bodies map to stable WorkboardErrors (413/400).
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new PayloadTooLargeError();
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new PayloadTooLargeError();
  }
  if (text.trim().length === 0) {
    throw new ValidationError("A JSON request body is required.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("Malformed JSON body.");
  }
}
