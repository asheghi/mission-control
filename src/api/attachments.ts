// Attachment routes: upload bytes, list metadata, serve content, delete.
//
// Two transport decisions are deliberate:
//
// - One raw body per file, rather than `multipart/form-data`. Multipart exists
//   to carry several fields plus files in one request; here each request is one
//   file with two headers' worth of metadata, and a streaming multipart parser
//   is a large, security-sensitive piece of code to hand-write for no gain.
//   It also lets the browser upload a dropped folder as independent requests
//   with their own progress and retries.
// - Content is served only through this authenticated route, never from a
//   public object URL, so revoking a token revokes access to the bytes.
import type { WorkboardService } from "../app/workboard";
import { attachmentContentPath, type AttachmentDto } from "../app/dto";
import { MAX_UPLOAD_BYTES, sniffPrefixBytes } from "../app/attachment-policy";
import { NotFoundError, ValidationError } from "../domain/errors";
import { jsonSuccess, streamBody } from "./response";
import type { HttpRouter } from "./router";
import { parseIdParam } from "./items";

export interface AttachmentRouteDeps {
  readonly service: WorkboardService;
}

export function registerAttachmentRoutes(router: HttpRouter, deps: AttachmentRouteDeps): void {
  router.add("POST", "/api/items/:id/attachments", async (ctx) => {
    return upload(ctx, deps, { itemId: parseIdParam(ctx.params.id) });
  });

  router.add("POST", "/api/comments/:id/attachments", async (ctx) => {
    return upload(ctx, deps, { commentId: parseIdParam(ctx.params.id) });
  });

  router.add("POST", "/api/attachments", async (ctx) => {
    // A convenient alias for callers that already know the target: the same
    // body, with the parent named by a query parameter.
    const itemId = ctx.url.searchParams.get("itemId");
    const commentId = ctx.url.searchParams.get("commentId");
    if (itemId !== null && commentId !== null) {
      throw new ValidationError("Provide exactly one of itemId or commentId.");
    }
    if (itemId !== null) return upload(ctx, deps, { itemId: parseIdParam(itemId) });
    if (commentId !== null) return upload(ctx, deps, { commentId: parseIdParam(commentId) });
    throw new ValidationError("Provide exactly one of itemId or commentId.");
  });

  router.add("GET", "/api/items/:id/attachments", (ctx) => {
    return jsonSuccess(deps.service.listItemAttachments(ctx.actor, parseIdParam(ctx.params.id)), undefined, ctx.requestId);
  });

  router.add("GET", "/api/comments/:id/attachments", (ctx) => {
    return jsonSuccess(deps.service.listCommentAttachments(ctx.actor, parseIdParam(ctx.params.id)), undefined, ctx.requestId);
  });

  router.add("GET", "/api/attachments/:id", (ctx) => {
    return jsonSuccess(deps.service.getAttachment(ctx.actor, parseIdParam(ctx.params.id)), undefined, ctx.requestId);
  });

  router.add("GET", "/api/attachments/:id/content", async (ctx) => {
    return serveContent(ctx, deps, false);
  });

  router.add("HEAD", "/api/attachments/:id/content", async (ctx) => {
    return serveContent(ctx, deps, true);
  });

  router.add("DELETE", "/api/attachments/:id", async (ctx) => {
    const id = parseIdParam(ctx.params.id);
    await deps.service.deleteAttachment(ctx.actor, id);
    return jsonSuccess({ id, deleted: true }, undefined, ctx.requestId);
  });
}

async function upload(
  ctx: { readonly request: Request; readonly actor: Parameters<WorkboardService["uploadAttachment"]>[0]; readonly requestId: string },
  deps: AttachmentRouteDeps,
  target: { itemId?: number; commentId?: number },
): Promise<Response> {
  // The declared type is read here but believed nowhere: the service verifies it
  // against the bytes before anything is stored.
  const declaredMediaType = ctx.request.headers.get("content-type") ?? "";
  const attachment = await deps.service.uploadAttachment(ctx.actor, {
    ...target,
    declaredMediaType,
    filename: decodeFilenameHeader(ctx.request.headers),
    body: streamBody(ctx.request, MAX_UPLOAD_BYTES, sniffPrefixBytes(declaredMediaType)),
  });
  return jsonSuccess(attachment, undefined, ctx.requestId, 201);
}

/**
 * Serve an attachment's bytes.
 *
 * Ranges are supported because a browser will not seek in a video without them:
 * without `Accept-Ranges` it either re-downloads the whole file or refuses to
 * play past the buffered window.
 */
async function serveContent(
  ctx: { readonly request: Request; readonly params: Record<string, string>; readonly actor: Parameters<WorkboardService["openAttachment"]>[0]; readonly requestId: string },
  deps: AttachmentRouteDeps,
  headOnly: boolean,
): Promise<Response> {
  const id = parseIdParam(ctx.params.id);
  // A HEAD describes the resource; it must not honour Range. A server that
  // answers HEAD with 206 and a partial length makes a client believe the
  // resource is shorter than it is.
  //
  // `If-Range` is honoured by refusing to honour `Range`: when the validator
  // does not match what we would send, the correct answer is the full
  // representation, which is what returning null here produces. Without this a
  // client resuming a download against changed content would silently splice
  // two different versions together.
  const rangeHeader = ctx.request.headers.get("range");
  const ifRange = ctx.request.headers.get("if-range");

  // The size has to be known before a range can be resolved, so metadata is read
  // first; the body is only opened once the offsets are decided.
  const attachment = deps.service.getAttachment(ctx.actor, id);

  // `If-Range` is honoured by declining to honour `Range`: when the validator
  // does not describe the current bytes, the correct answer is the full
  // representation. Answering 206 anyway would let a client resuming a download
  // splice two different versions of a file together. The attachment's sha256 is
  // the validator, and it is also served as a strong ETag.
  const parsedRange =
    headOnly || rangeHeader === null || (ifRange !== null && !ifRangeMatches(ifRange, attachment.sha256))
      ? null
      : parseRangeHeader(rangeHeader);
  const requested = parsedRange === null ? null : resolveRange(parsedRange, attachment.sizeBytes);
  if (parsedRange !== null && requested === null) {
    return rangeNotSatisfiable(attachment.sizeBytes, ctx.requestId);
  }

  const opened = await deps.service.openAttachment(ctx.actor, id, requested ?? undefined);
  const headers = contentHeaders(opened.attachment, opened.mediaType, ctx.requestId);
  const total = opened.size;

  if (headOnly) {
    // A HEAD must not pull the body, but must report the same metadata.
    await opened.body.cancel("head request").catch(() => {});
  }

  // `Content-Length` is set only where the body is empty, because a streamed
  // body from a bridged Node stream — the filesystem backend — is sent chunked
  // and Bun drops an explicit length. Asserting one anyway would be a lie the
  // client might act on. `Content-Range` carries the offsets a client needs to
  // seek, and every response is correctly delimited either way.
  if (requested === null) {
    if (headOnly) headers.set("Content-Length", String(total));
    return new Response(headOnly ? null : opened.body, { status: 200, headers });
  }

  headers.set("Content-Range", `bytes ${requested.start}-${requested.endInclusive}/${total}`);
  if (headOnly) {
    headers.set("Content-Length", String(requested.endInclusive - requested.start + 1));
  }
  return new Response(headOnly ? null : opened.body, { status: 206, headers });
}



/**
 * Whether an `If-Range` validator still describes the current bytes.
 *
 * The attachment's sha256 is the validator: it changes exactly when the contents
 * do, and it is served as a strong ETag. A date-form validator is not accepted,
 * because without a recorded modification time it cannot be compared honestly;
 * declining to match is the safe answer, since it yields the whole file rather
 * than a splice.
 */
function ifRangeMatches(ifRange: string, sha256: string): boolean {
  const value = ifRange.trim();
  if (value === "" || sha256 === "") return false;
  return value === `"${sha256}"` || value.toLowerCase() === sha256.toLowerCase();
}

/** A range the object cannot satisfy: the protocol answer is 416. */
function rangeNotSatisfiable(size: number, requestId: string): Response {
  return new Response(null, {
    status: 416,
    headers: {
      "Content-Range": `bytes */${size}`,
      "Accept-Ranges": "bytes",
      "X-Request-Id": requestId,
    },
  });
}

/**
 * Headers every attachment response carries.
 *
 * The security headers are not decoration. These bytes are served from the
 * application's own origin, so a file that a browser is willing to execute
 * would run with the board's privileges. Uploads are restricted to a small set
 * of image and video types for that reason, and these headers hold the line for
 * anything unforeseen: no sniffing, no script, no embedding elsewhere, and no
 * caching of credential-protected media.
 */
function contentHeaders(attachment: AttachmentDto, mediaType: string, requestId: string): Headers {
  const headers = new Headers({
    "X-Request-Id": requestId,
    "Content-Type": mediaType,
    "Accept-Ranges": "bytes",
    // The digest of the stored bytes, which is exactly what If-Range compares.
    ...(attachment.sha256 === "" ? {} : { ETag: `"${attachment.sha256}"` }),
    // The digest of the stored bytes, which is exactly what If-Range compares.
    ...(attachment.sha256 === "" ? {} : { ETag: `"${attachment.sha256}"` }),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "private, no-store",
    "Content-Disposition": contentDisposition(attachment.filename),
  });
  return headers;
}

/**
 * Render a download name safely.
 *
 * Only the stored, sanitized filename is used, and only in the quoted and the
 * RFC 5987 forms. A newline or a quote that reached this header would let an
 * upload inject response headers.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  let encoded: string;
  try {
    encoded = encodeURIComponent(filename);
  } catch {
    // A name that cannot be percent-encoded (a lone surrogate that slipped past
    // sanitizing) must not fail the whole response: fall back to the ASCII form.
    encoded = encodeURIComponent(ascii);
  }
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Parse a single `bytes=` range.
 *
 * Multiple ranges are refused rather than half-supported: answering them
 * correctly needs a multipart response, and no browser asks for one when
 * playing media. A suffix range (`bytes=-500`) and an open-ended range
 * (`bytes=500-`) are resolved against the object size by the caller, which is
 * the only place the size is known.
 */
export type ParsedRange =
  | { readonly kind: "bounded"; readonly start: number; readonly endInclusive: number }
  | { readonly kind: "suffix"; readonly length: number }
  | { readonly kind: "open"; readonly start: number };

export function parseRangeHeader(header: string | null): ParsedRange | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) {
    // A syntactically valid but unsupported form (multiple ranges, or a unit
    // other than bytes) is ignored: RFC 9110 lets a server send the whole
    // representation when it does not honour the range.
    return null;
  }
  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { kind: "suffix", length: suffix };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start < 0) return null;
  if (rawEnd === "") return { kind: "open", start };
  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { kind: "bounded", start, endInclusive: end };
}

/**
 * Turn a parsed range into concrete offsets, or null when it cannot be
 * satisfied by an object of this size (which is answered with 416).
 */
export function resolveRange(
  range: ParsedRange,
  size: number,
): { readonly start: number; readonly endInclusive: number } | null {
  if (size <= 0) return null;
  switch (range.kind) {
    case "suffix": {
      // The last N bytes; asking for more than exists means the whole object.
      const start = Math.max(0, size - range.length);
      return { start, endInclusive: size - 1 };
    }
    case "open":
      if (range.start >= size) return null;
      return { start: range.start, endInclusive: size - 1 };
    case "bounded":
      if (range.start >= size) return null;
      // An end past the object is clamped, as the protocol requires.
      return { start: range.start, endInclusive: Math.min(range.endInclusive, size - 1) };
  }
}

/**
 * Read the upload filename from a header.
 *
 * `X-Filename` carries the percent-encoded name; `Content-Disposition` is
 * accepted as a fallback for clients that model the upload as a form part.
 * Whatever arrives is a display name only — it never becomes a path.
 */
function decodeFilenameHeader(headers: Headers): string | null {
  const direct = headers.get("x-filename");
  if (direct !== null && direct !== "") return decodePercent(direct);
  const disposition = headers.get("content-disposition");
  if (disposition === null) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  return match?.[1] === undefined ? null : decodePercent(match[1]);
}

function decodePercent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding must not fail the upload: the name is
    // cosmetic, and the stored bytes are what matter.
    return raw;
  }
}

export { attachmentContentPath };
