import { describe, expect, test } from "bun:test";
import { statusTimestamps } from "../../../src/domain/transitions";

describe("statusTimestamps", () => {
  test.each([
    ["todo", "doing", null, "T2", null],
    ["todo", "doing", "T1", "T2", "T1"],
    ["doing", "done", null, "T2", "T2"],
    ["blocked", "done", "T1", "T2", "T2"],
    ["done", "todo", "T1", "T2", null],
    ["done", "doing", null, "T2", null],
    ["done", "blocked", "T1", "T2", null],
    ["done", "done", "T1", "T2", "T1"],
    ["todo", "blocked", null, "T2", null],
    ["todo", "blocked", "T1", "T2", "T1"],
    ["doing", "todo", null, "T2", null],
  ] as const)(
    "%p → %p (closedAt=%p) at %p",
    (previous, next, currentClosedAt, now, expected) => {
      expect(statusTimestamps(previous, next, currentClosedAt, now).closedAt).toBe(expected);
    },
  );
});
