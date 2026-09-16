import { DIFF_MAX_LINE_LENGTH, DIFF_MAX_RENDERED_LINES, LABEL_NAME_MAX_LENGTH, LABEL_SET_MAX } from "./types";
import type { DiffOperation, InlineToken, MentionTrigger, NormalizedLink } from "./types";

const LCS_CELL_BUDGET = 400_000;
const LINK_PATTERN = /^\[([^\]\n]+)\]\(([^\s)]+)\)$/;
const INLINE_PATTERN = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\))/g;

export function normalizeLinkUrl(raw: string, baseOrigin?: string): NormalizedLink | null {
  const value = raw.trim();
  if (value === "" || value.startsWith(String.fromCharCode(47, 47)) || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (/^(?:javascript|data|vbscript):/i.test(value)) return null;
  const explicitScheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (explicitScheme !== undefined && explicitScheme !== "http" && explicitScheme !== "https" && explicitScheme !== "mailto") return null;
  if (explicitScheme === "mailto") {
    try {
      const url = new URL(value);
      return url.protocol === "mailto:" ? { href: url.href, external: false } : null;
    } catch {
      return null;
    }
  }
  if (explicitScheme === "http" || explicitScheme === "https") {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? { href: url.href, external: true } : null;
    } catch {
      return null;
    }
  }
  try {
    const fallbackOrigin = ["http:", "", "localhost"].join("/");
    const base = new URL(baseOrigin ?? fallbackOrigin);
    const url = new URL(value, base);
    if (url.origin !== base.origin || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
    return { href: `${url.pathname}${url.search}${url.hash}`, external: false };
  } catch {
    return null;
  }
}

export function tokenizeInline(text: string, baseOrigin?: string): readonly InlineToken[] {
  const tokens: InlineToken[] = [];
  let index = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index;
    const raw = match[0];
    if (start > index) tokens.push({ kind: "text", text: text.slice(index, start) });
    if (raw.startsWith("**")) tokens.push({ kind: "strong", text: raw.slice(2, -2) });
    else if (raw.startsWith("*")) tokens.push({ kind: "em", text: raw.slice(1, -1) });
    else if (raw.startsWith("`")) tokens.push({ kind: "code", text: raw.slice(1, -1) });
    else {
      const linkMatch = LINK_PATTERN.exec(raw);
      const link = linkMatch?.[2] === undefined ? null : normalizeLinkUrl(linkMatch[2], baseOrigin);
      if (link === null || linkMatch?.[1] === undefined) tokens.push({ kind: "text", text: raw });
      else tokens.push({ kind: "link", text: linkMatch[1], link });
    }
    index = start + raw.length;
  }
  if (index < text.length) tokens.push({ kind: "text", text: text.slice(index) });
  return tokens;
}

export function mentionTrigger(text: string, caret: number): MentionTrigger | null {
  const safeCaret = Math.min(Math.max(Number.isSafeInteger(caret) ? caret : 0, 0), text.length);
  const before = text.slice(0, safeCaret);
  const start = before.lastIndexOf("@");
  if (start < 0 || (start > 0 && !/\s/.test(before[start - 1] ?? ""))) return null;
  const query = before.slice(start + 1);
  if (/\s/.test(query)) return null;
  return { start, query };
}

export function insertMention(text: string, caret: number, trigger: MentionTrigger, name: string): { value: string; caret: number } {
  const safeCaret = Math.min(Math.max(caret, trigger.start + 1), text.length);
  const insertion = `@${name} `;
  return {
    value: `${text.slice(0, trigger.start)}${insertion}${text.slice(safeCaret)}`,
    caret: trigger.start + insertion.length,
  };
}

export function deterministicLabelColor(name: string, palette: readonly string[]): string {
  if (palette.length === 0) return "#3B82F6";
  let hash = 2166136261;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return palette[hash % palette.length] ?? palette[0] ?? "#3B82F6";
}

/**
 * Normalize one user-typed label name against the server's own rules
 * (`labelNameSchema`: trimmed, 1-64 characters). Returns null when the name
 * cannot be sent, so the caller reports a reason instead of provoking a 400.
 */
export function normalizeLabelName(raw: string): string | null {
  const name = String(raw ?? "").trim();
  if (name === "") return null;
  if (name.length > LABEL_NAME_MAX_LENGTH) return null;
  // Control characters would not survive a round trip through the API's JSON
  // and history rendering, so they are rejected rather than silently mangled.
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** The outcome of validating one label addition against the current set. */
export type LabelAddCheck =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate adding `raw` to `selected`. Enforces the server's trimmed 1-64
 * character name limit, rejects a duplicate, and refuses to exceed the 20-label
 * array bound the item schemas enforce — each with a specific reason, because
 * "Label changes could not be saved" after a round trip tells the user nothing.
 */
export function checkLabelAdd(raw: string, selected: readonly string[]): LabelAddCheck {
  const name = normalizeLabelName(raw);
  if (name === null) {
    return { ok: false, reason: String(raw ?? "").trim() === ""
      ? "Enter a label name."
      : `Label names must be 1-${LABEL_NAME_MAX_LENGTH} characters.` };
  }
  if (selected.includes(name)) return { ok: false, reason: `Already labelled ${name}.` };
  if (selected.length >= LABEL_SET_MAX) {
    return { ok: false, reason: `An item can have at most ${LABEL_SET_MAX} labels.` };
  }
  return { ok: true, name };
}

/**
 * Deduplicate and validate a whole label set before it is sent. Names that
 * cannot be sent are dropped, so an over-long or blank entry can never turn a
 * valid edit into a rejected request.
 */
export function normalizeLabelSet(names: readonly string[]): readonly string[] {
  const next: string[] = [];
  for (const raw of names) {
    const name = normalizeLabelName(raw);
    if (name === null || next.includes(name)) continue;
    next.push(name);
    if (next.length >= LABEL_SET_MAX) break;
  }
  return next;
}

export interface BoundedDiff {
  readonly operations: readonly DiffOperation[];
  /** True when operations or line text were shortened for rendering. */
  readonly truncated: boolean;
}

/**
 * Bound a diff for rendering: clip pathologically long lines and cap the number
 * of operations. The returned `truncated` flag drives an explicit notice, so a
 * shortened view is never presented as the complete change.
 */
export function boundDiff(operations: readonly DiffOperation[]): BoundedDiff {
  let truncated = false;
  const clipped: DiffOperation[] = [];
  for (const operation of operations.slice(0, DIFF_MAX_RENDERED_LINES)) {
    const line = truncateLine(operation.line, DIFF_MAX_LINE_LENGTH);
    if (line !== operation.line) truncated = true;
    clipped.push(line === operation.line ? operation : { type: operation.type, line });
  }
  if (operations.length > clipped.length) truncated = true;
  return { operations: clipped, truncated };
}

/** Clip one line to `max` characters, marking the cut with an ellipsis. */
export function truncateLine(line: string, max: number): string {
  const value = String(line ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export function diffLines(oldText: string | null | undefined, newText: string | null | undefined): readonly DiffOperation[] {
  const before = String(oldText ?? "").split("\n");
  const after = String(newText ?? "").split("\n");
  const n = before.length;
  const m = after.length;
  // Division-based bounds avoid overflowing a product, while the dimension cap
  // also bounds typed-array/object overhead for very tall one-column diffs.
  if (n > 4_096 || m > 4_096 || n + 1 > Math.floor(LCS_CELL_BUDGET / (m + 1))) return fallbackDiff(before, after);

  const rows = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const nextRow = rows[i + 1];
    if (row === undefined || nextRow === undefined) return fallbackDiff(before, after);
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = before[i] === after[j]
        ? (nextRow[j + 1] ?? 0) + 1
        : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const operations: DiffOperation[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const oldLine = before[i] ?? "";
    const newLine = after[j] ?? "";
    if (oldLine === newLine) {
      operations.push({ type: "ctx", line: oldLine });
      i += 1;
      j += 1;
    } else if ((rows[i + 1]?.[j] ?? 0) >= (rows[i]?.[j + 1] ?? 0)) {
      operations.push({ type: "del", line: oldLine });
      i += 1;
    } else {
      operations.push({ type: "add", line: newLine });
      j += 1;
    }
  }
  while (i < n) operations.push({ type: "del", line: before[i++] ?? "" });
  while (j < m) operations.push({ type: "add", line: after[j++] ?? "" });
  return operations;
}

function fallbackDiff(before: readonly string[], after: readonly string[]): readonly DiffOperation[] {
  return [
    ...before.map((line): DiffOperation => ({ type: "del", line })),
    ...after.map((line): DiffOperation => ({ type: "add", line })),
  ];
}

export function formatTime(iso: string): string {
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? iso : value.toLocaleString();
}
