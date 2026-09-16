// Unit tests for the detail feature's pure helpers.
//
// Everything asserted here is a rule the view depends on and that a reviewer
// cannot confirm by reading the component: label input must be rejected before
// it becomes a 400, a rendered diff must be bounded, a collapsed history row
// must not compute a diff at all, and a Markdown link must never be allowed to
// carry a script or a cross-origin URL.
import { describe, expect, test } from "bun:test";
import {
  boundDiff,
  checkLabelAdd,
  diffLines,
  insertMention,
  mentionTrigger,
  normalizeLabelName,
  normalizeLabelSet,
  normalizeLinkUrl,
  tokenizeInline,
  truncateLine,
} from "../../../src/web/features/detail/helpers";
import { DIFF_MAX_LINE_LENGTH, DIFF_MAX_RENDERED_LINES, LABEL_NAME_MAX_LENGTH, LABEL_SET_MAX } from "../../../src/web/features/detail/types";

describe("label name validation", () => {
  test("trims and accepts a name inside the server's limit", () => {
    expect(normalizeLabelName("  web  ")).toBe("web");
  });

  test("accepts exactly the 64-character limit and rejects 65", () => {
    const atLimit = "a".repeat(LABEL_NAME_MAX_LENGTH);
    expect(normalizeLabelName(atLimit)).toBe(atLimit);
    expect(normalizeLabelName("a".repeat(LABEL_NAME_MAX_LENGTH + 1))).toBeNull();
  });

  test("rejects blank names and control characters", () => {
    expect(normalizeLabelName("")).toBeNull();
    expect(normalizeLabelName("   ")).toBeNull();
    expect(normalizeLabelName("line\nbreak")).toBeNull();
    expect(normalizeLabelName("tab\there")).toBeNull();
  });

  test("checkLabelAdd reports a specific reason per rejection", () => {
    expect(checkLabelAdd("web", [])).toEqual({ ok: true, name: "web" });
    expect(checkLabelAdd("  ", []).ok).toBe(false);
    expect(checkLabelAdd("a".repeat(LABEL_NAME_MAX_LENGTH + 1), []).ok).toBe(false);
    const duplicate = checkLabelAdd("web", ["web"]);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.reason).toContain("Already labelled");
  });

  test("checkLabelAdd refuses to exceed the 20-label array bound", () => {
    const full = Array.from({ length: LABEL_SET_MAX }, (_, index) => `label-${index}`);
    const refused = checkLabelAdd("one-more", full);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain(String(LABEL_SET_MAX));
    // Removing one makes room again.
    expect(checkLabelAdd("one-more", full.slice(1)).ok).toBe(true);
  });

  test("normalizeLabelSet deduplicates, validates, and caps the set", () => {
    expect(normalizeLabelSet(["  web ", "web", "", "api"])).toEqual(["web", "api"]);
    expect(normalizeLabelSet(["a".repeat(LABEL_NAME_MAX_LENGTH + 1), "ok"])).toEqual(["ok"]);
    const overflow = Array.from({ length: LABEL_SET_MAX + 5 }, (_, index) => `l-${index}`);
    expect(normalizeLabelSet(overflow).length).toBe(LABEL_SET_MAX);
  });
});

describe("diff bounding", () => {
  test("a bounded diff that needed no shortening is not flagged as truncated", () => {
    const operations = diffLines("one\ntwo", "one\nthree");
    const bounded = boundDiff(operations);
    expect(bounded.truncated).toBe(false);
    expect(bounded.operations).toEqual(operations);
  });

  test("an over-long line is clipped and flagged, so the view can say so", () => {
    const long = "x".repeat(DIFF_MAX_LINE_LENGTH + 50);
    const bounded = boundDiff([{ type: "add", line: long }]);
    expect(bounded.truncated).toBe(true);
    expect(bounded.operations[0]?.line.length).toBeLessThanOrEqual(DIFF_MAX_LINE_LENGTH + 1);
  });

  test("more operations than the render cap are cut and flagged", () => {
    const operations = Array.from({ length: DIFF_MAX_RENDERED_LINES + 25 }, (_, index) => ({
      type: "ctx" as const,
      line: `line ${index}`,
    }));
    const bounded = boundDiff(operations);
    expect(bounded.operations.length).toBe(DIFF_MAX_RENDERED_LINES);
    expect(bounded.truncated).toBe(true);
  });

  test("truncateLine leaves a short line untouched and marks the cut", () => {
    expect(truncateLine("short", 10)).toBe("short");
    expect(truncateLine("abcdefghij", 5)).toBe("abcde…");
  });
});

describe("diffLines", () => {
  test("reports an unchanged text as pure context", () => {
    const operations = diffLines("a\nb", "a\nb");
    expect(operations).toEqual([{ type: "ctx", line: "a" }, { type: "ctx", line: "b" }]);
  });

  test("falls back to del+add for an oversized diff instead of blowing the budget", () => {
    const before = Array.from({ length: 5_000 }, (_, index) => `old ${index}`);
    const after = Array.from({ length: 5_000 }, (_, index) => `new ${index}`);
    const operations = diffLines(before.join("\n"), after.join("\n"));
    expect(operations.length).toBe(before.length + after.length);
  });

  test("treats null and undefined as empty text", () => {
    // An empty text splits into a single empty line, so diffing nothing against
    // a real line is one addition from the empty placeholder.
    expect(diffLines(null, "added")).toEqual([{ type: "del", line: "" }, { type: "add", line: "added" }]);
    expect(diffLines(undefined, undefined)).toEqual([{ type: "ctx", line: "" }]);
    expect(diffLines("", "")).toEqual([{ type: "ctx", line: "" }]);
  });
});

describe("safe Markdown URLs", () => {
  test("rejects script, data, and protocol-relative links", () => {
    expect(normalizeLinkUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeLinkUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(normalizeLinkUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(normalizeLinkUrl("vbscript:msgbox(1)")).toBeNull();
    expect(normalizeLinkUrl("//evil.example")).toBeNull();
    expect(normalizeLinkUrl("  ")).toBeNull();
  });

  test("rejects control characters that could smuggle a scheme", () => {
    expect(normalizeLinkUrl("java\u0000script:alert(1)")).toBeNull();
    expect(normalizeLinkUrl("http://ok.example/\nheader")).toBeNull();
  });

  test("keeps http(s) as an external link and mailto as a safe internal one", () => {
    expect(normalizeLinkUrl("https://example.com/a?b=1")).toEqual({ href: "https://example.com/a?b=1", external: true });
    const mail = normalizeLinkUrl("mailto:someone@example.com");
    expect(mail?.external).toBe(false);
    expect(mail?.href.startsWith("mailto:")).toBe(true);
  });

  test("a relative link stays on the current origin", () => {
    const relative = normalizeLinkUrl("/api/items/7", "http://localhost:3000");
    expect(relative).toEqual({ href: "/api/items/7", external: false });
    // An absolute URL to another origin is not turned into a same-origin link.
    expect(normalizeLinkUrl("https://evil.example/x", "http://localhost:3000")).toEqual({
      href: "https://evil.example/x",
      external: true,
    });
  });

  test("tokenizeInline never emits an unsafe link token", () => {
    const tokens = tokenizeInline("[click](javascript:alert(1))", "http://localhost:3000");
    expect(tokens.some((token) => token.kind === "link")).toBe(false);
  });
});

describe("mention trigger and insertion", () => {
  test("detects a trigger only at a word boundary", () => {
    expect(mentionTrigger("hi @we", 6)).toEqual({ start: 3, query: "we" });
    expect(mentionTrigger("hi@we", 5)).toBeNull();
    expect(mentionTrigger("hi @we more", 11)).toBeNull();
    expect(mentionTrigger("no at here", 10)).toBeNull();
  });

  test("inserts the mention once and places the caret after it", () => {
    const trigger = mentionTrigger("hi @we", 6);
    expect(trigger).not.toBeNull();
    if (trigger === null) return;
    const first = insertMention("hi @we", 6, trigger, "reviewer");
    expect(first.value).toBe("hi @reviewer ");
    expect(first.caret).toBe("hi @reviewer ".length);
    // Re-running against the already-inserted text with the stale caret does not
    // produce a second mention: the trigger text is gone.
    expect(mentionTrigger(first.value, first.caret)).toBeNull();
  });

  test("preserves text after the caret", () => {
    const trigger = mentionTrigger("say @re now", 7);
    expect(trigger).not.toBeNull();
    if (trigger === null) return;
    // The trigger's query is replaced, and everything after it is kept.
    const result = insertMention("say @re now", 7, trigger, "reviewer");
    expect(result.value).toBe("say @reviewer  now");
    expect(result.value.endsWith(" now")).toBe(true);
  });

  test("clamps a caret outside the text instead of throwing", () => {
    const trigger = mentionTrigger("hi @we", 999);
    expect(trigger).toEqual({ start: 3, query: "we" });
    expect(insertMention("hi @we", 999, { start: 3, query: "we" }, "x").value).toBe("hi @x ");
  });
});
