// Transport-facing upload policy.
//
// The accepted media types and per-kind caps live in `domain/attachments`; this
// module is the one place that turns them into the numbers a transport needs, so
// REST, MCP, and the web UI cannot disagree about what is allowed.
import { ATTACHMENT_MAX_BYTES, SNIFF_PREFIX_BYTES, mediaKindOf } from "../domain/attachments";

/**
 * Hard ceiling for any single upload, applied while streaming.
 *
 * This is the largest per-kind cap, not a replacement for it: the request is
 * bounded first at this size (so an unknown type cannot stream forever), and the
 * service then enforces the tighter per-kind cap once the type is known.
 */
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(ATTACHMENT_MAX_BYTES));

/** How many leading bytes are captured for signature sniffing. */
export function sniffPrefixBytes(declaredMediaType: string): number {
  // The prefix is a fixed small window; the declared type is accepted here only
  // so a caller cannot be tempted to pass a size derived from client input.
  void declaredMediaType;
  return SNIFF_PREFIX_BYTES;
}

/** The cap that applies once a type is known. */
export function uploadCapFor(mediaType: string): number {
  return ATTACHMENT_MAX_BYTES[mediaKindOf(mediaType)];
}
