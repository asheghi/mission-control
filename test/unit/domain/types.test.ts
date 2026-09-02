import { describe, expect, test } from "bun:test";
import { PRIORITIES, PARTICIPANT_KINDS, WORK_STATUSES, systemClock } from "../../../src/domain/types";

describe("domain constants", () => {
  test("participant kinds", () => {
    expect([...PARTICIPANT_KINDS]).toEqual(["human", "agent"]);
  });

  test("work statuses", () => {
    expect([...WORK_STATUSES]).toEqual(["todo", "doing", "blocked", "done"]);
  });

  test("priorities", () => {
    expect([...PRIORITIES]).toEqual([0, 1, 2, 3]);
  });
});

describe("systemClock", () => {
  test("produces UTC ISO-8601 timestamps", () => {
    const now = systemClock.now();
    expect(typeof now).toBe("string");
    expect(now.endsWith("Z")).toBe(true);
    expect(Number.isNaN(Date.parse(now))).toBe(false);
    expect(Date.parse(now)).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
