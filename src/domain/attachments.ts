// Accepted attachment media, and the checks that a claimed type is believable.
//
// The accepted set is a closed allowlist rather than "anything": these files are
// served back from the application's own origin, and formats that can execute
// in a browser context are not worth the risk here. SVG is the notable refusal —
// it is an image by intent and a script host by capability.
//
// A client's Content-Type is a claim, never evidence, so `sniffMediaType`
// inspects leading bytes and the caller rejects a mismatch instead of trusting
// or silently rewriting the header.
import { ValidationError } from "./errors";

export const ATTACHMENT_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm"] as const;
export type AttachmentMediaType = (typeof ATTACHMENT_MEDIA_TYPES)[number];

export const ATTACHMENT_KINDS = ["image", "video"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Bytes needed to recognise every accepted format; MP4/WebM brand sits early. */
export const SNIFF_PREFIX_BYTES = 64;

const MEBIBYTE = 1024 * 1024;
/** Per-kind caps. Enforced while streaming, never after the bytes have landed. */
export const ATTACHMENT_MAX_BYTES: Readonly<Record<AttachmentKind, number>> = {
  image: 20 * MEBIBYTE,
  video: 250 * MEBIBYTE,
};

/** Largest image an MCP client is given as an inline content block. */
export const MCP_INLINE_IMAGE_MAX_BYTES = 4 * MEBIBYTE;

export const FILENAME_MAX_LENGTH = 255;

export function mediaKindOf(mediaType: string): AttachmentKind {
  return mediaType.startsWith("video/") ? "video" : "image";
}

export function maxBytesFor(mediaType: string): number {
  return ATTACHMENT_MAX_BYTES[mediaKindOf(mediaType)];
}

export function isAcceptedMediaType(value: string): value is AttachmentMediaType {
  return (ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * The media type these leading bytes actually are, or null when unrecognised.
 *
 * Recognises the six accepted formats by signature. It proves the format
 * family, not that the whole file is valid media — a full parse would need a
 * real demuxer, which is out of scope for an attachment store.
 */
export function sniffMediaType(prefix: Uint8Array): AttachmentMediaType | null {
  if (startsWith(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(prefix, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(prefix, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(prefix, [0x52, 0x49, 0x46, 0x46]) && asciiAt(prefix, 8, "WEBP")) return "image/webp";
  // ISO base media file format: a 4-byte box length, then `ftyp`, then a brand.
  if (asciiAt(prefix, 4, "ftyp") && hasIsoBrand(prefix)) return "video/mp4";
  if (startsWith(prefix, [0x1a, 0x45, 0xdf, 0xa3]) && hasEbmlDocType(prefix, "webm")) return "video/webm";
  return null;
}

/** MP4 in practice: `isom`, `iso2`, `mp41`, `mp42`, `avc1`, `dash`, `M4V `. */
const ISO_BRANDS = ["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "mmp4", "M4V ", "M4A "];

function hasIsoBrand(prefix: Uint8Array): boolean {
  return ISO_BRANDS.some((brand) => asciiAt(prefix, 8, brand));
}

/**
 * EBML nests the DocType inside the header, so it is searched for rather than
 * read at a fixed offset. Two details matter: the element's size is a
 * variable-length integer whose width is encoded in its leading byte (assuming
 * one byte only works for short values), and matching the declared type keeps a
 * `.mkv` out of the allowlist — it shares the container but declares
 * `matroska`.
 */
function hasEbmlDocType(prefix: Uint8Array, expected: string): boolean {
  const DOCTYPE_ID = [0x42, 0x82];
  for (let index = 0; index + 4 <= prefix.length; index += 1) {
    if (prefix[index] !== DOCTYPE_ID[0] || prefix[index + 1] !== DOCTYPE_ID[1]) continue;
    const sizeByte = prefix[index + 2] ?? 0;
    const sizeWidth = vintWidth(sizeByte);
    if (sizeWidth === null) continue;
    const declaredAt = index + 2 + sizeWidth;
    if (asciiAt(prefix, declaredAt, expected)) return true;
  }
  return false;
}

/** Width in bytes of an EBML variable-length integer, or null when malformed. */
function vintWidth(leadingByte: number): number | null {
  for (let width = 1; width <= 8; width += 1) {
    if ((leadingByte & (0x80 >> (width - 1))) !== 0) return width;
  }
  return null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * Reduce a client-supplied filename to a safe display name.
 *
 * The result is only ever rendered and stored, never joined to a path, but it
 * still must not carry separators, traversal, control characters, or a length
 * that would let one upload bloat a listing.
 */
export function sanitizeFilename(raw: string | null | undefined, fallback = "attachment"): string {
  if (raw === null || raw === undefined) return fallback;
  // Strip any directory part first, then anything that could still confuse a
  // renderer or a shell downstream.
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  if (cleaned === "") return fallback;
  // An unpaired surrogate is accepted by JSON and MCP but cannot be encoded into
  // a header: `encodeURIComponent` throws on it, which would turn one upload into
  // a permanent 500 on that attachment's content route. Normalizing here keeps
  // the stored name encodable.
  const wellFormed = toWellFormed(cleaned);
  if (wellFormed === "") return fallback;
  return wellFormed.length > FILENAME_MAX_LENGTH ? wellFormed.slice(0, FILENAME_MAX_LENGTH) : wellFormed;
}

/** Replace lone surrogates with U+FFFD, using the runtime helper when present. */
function toWellFormed(value: string): string {
  const native = (value as { toWellFormed?: () => string }).toWellFormed;
  if (typeof native === "function") return native.call(value);
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[index]! + value[index + 1]!;
        index += 1;
        continue;
      }
      out += "\uFFFD";
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
      continue;
    }
    out += value[index]!;
  }
  return out;
}

/**
 * Validate a claimed media type against sniffed bytes. A mismatch is refused
 * outright: rewriting the claim would hide a lying or buggy client, and the
 * declared type is what later decides response headers.
 */
export function assertMediaTypeMatches(declared: string, prefix: Uint8Array): AttachmentMediaType {
  const normalized = declared.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isAcceptedMediaType(normalized)) {
    throw new ValidationError(`Unsupported attachment type ${normalized === "" ? "(none)" : normalized}.`, {
      accepted: [...ATTACHMENT_MEDIA_TYPES],
    });
  }
  const sniffed = sniffMediaType(prefix);
  if (sniffed === null) {
    throw new ValidationError("The uploaded file is not a recognised image or video.");
  }
  if (sniffed !== normalized) {
    throw new ValidationError(`The uploaded file is ${sniffed}, not ${normalized}.`, {
      declared: normalized,
      detected: sniffed,
    });
  }
  return sniffed;
}

/**
 * Storage keys are random and row-owned (`attachments/<shard>/<id>`), never
 * content-addressed and never derived from a filename. A row-owned key keeps
 * deletion ownership unambiguous: no reference counting, and removing one
 * attachment can never remove bytes another row still points at.
 */
export function generateStorageKey(attachmentToken = crypto.randomUUID()): string {
  const compact = attachmentToken.replace(/-/g, "").toLowerCase();
  const shard = compact.slice(0, 2).padEnd(2, "0");
  return `attachments/${shard}/${compact}`;
}
