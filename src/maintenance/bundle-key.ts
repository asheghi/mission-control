// Where an attachment's bytes live inside a backup bundle.
//
// The key cannot be reused verbatim: the bundle is a directory a person may
// open and copy, so a key that is absolute, contains `..`, or carries
// separators could write outside the bundle. Verified against the same rules the
// filesystem backend enforces, then flattened to `<skipped>-<basename>` so a
// key like `attachments/ab/deadbeef` becomes a plain, predictable filename.
const SAFE_SEGMENT = /[^A-Za-z0-9._-]/g;

export function allocateBlobKey(attachmentId: number, storageKey: string): string {
  const leaf = storageKey.split("/").filter((part) => part !== "" && part !== "." && part !== "..").pop() ?? "";
  const cleaned = leaf.replace(SAFE_SEGMENT, "_").slice(-120);
  const suffix = cleaned === "" ? "blob" : cleaned;
  // The attachment id leads so two different keys can never collide, and so a
  // bundle's contents are traceable back to rows without reading the manifest.
  return `${attachmentId}-${suffix}`;
}
