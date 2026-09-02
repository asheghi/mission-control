import { describe, expect, test } from "bun:test";
import { parseMentionNames, resolveMentions } from "../../../src/domain/mentions";

describe("parseMentionNames", () => {
  test.each([
    ["@alice", ["alice"]],
    ["hello @bob", ["bob"]],
    ["ping @alice please", ["alice"]],
    ["@bob.", ["bob"]],
    ["(@carol)", ["carol"]],
    ["hi @alice!", ["alice"]],
    ["@dave @EVE", ["dave", "EVE"]],
    ["@bob @BOB @Bob", ["bob"]],
    ["@mary-jane and @a_b", ["mary-jane", "a_b"]],
    ["@a", ["a"]],
    [`@${"x".repeat(64)}`, ["x".repeat(64)]],
    ["@bob@carol", ["bob"]],
    // Edge cases: email-like text, code, punctuation, and over-long names.
    ["bob@example.com", []],
    ["mail bob@example.com", []],
    ["a@bob", []],
    ["-@bob", []],
    ["@@bob", []],
    [`@${"x".repeat(65)}`, []],
    ["", []],
    ["plain text", []],
  ] as const)("parseMentionNames(%p)", (text, expected) => {
    expect(parseMentionNames(text)).toEqual([...expected]);
  });
});

describe("resolveMentions", () => {
  const candidates = [
    { name: "alice", value: 1 },
    { name: "bob", value: 2 },
  ];

  test("resolves case-insensitively against participants", () => {
    expect(resolveMentions("@Alice", candidates)).toEqual([1]);
  });

  test("each participant yields at most one mention per source", () => {
    expect(resolveMentions("@alice @ALICE @alice", candidates)).toEqual([1]);
  });

  test("resolves multiple distinct participants", () => {
    expect(resolveMentions("@alice and @bob", candidates)).toEqual([1, 2]);
  });

  test("unknown names remain plain text and are not resolved", () => {
    expect(resolveMentions("@carol", candidates)).toEqual([]);
  });

  test("mentions inside emails never resolve", () => {
    expect(resolveMentions("write alice@example.com", candidates)).toEqual([]);
  });
});
