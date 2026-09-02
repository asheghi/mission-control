import { describe, expect, test } from "bun:test";
import {
  bodySchema,
  colorSchema,
  commentBodySchema,
  handleSchema,
  labelNameSchema,
  parseInput,
  participantKindSchema,
  positiveIdSchema,
  prioritySchema,
  titleSchema,
  tokenNameSchema,
  workStatusSchema,
} from "../../../src/domain/validation";
import { ValidationError } from "../../../src/domain/errors";

describe("enum validators", () => {
  test.each([
    ["human", true],
    ["agent", true],
    ["Human", false],
    ["robot", false],
    ["", false],
    [null, false],
    [undefined, false],
    [1, false],
  ] as const)("participantKindSchema(%p)", (value, ok) => {
    expect(participantKindSchema.safeParse(value).success).toBe(ok);
  });

  test.each([
    ["todo", true],
    ["doing", true],
    ["blocked", true],
    ["done", true],
    ["Todo", false],
    ["cancelled", false],
    ["", false],
    [null, false],
  ] as const)("workStatusSchema(%p)", (value, ok) => {
    expect(workStatusSchema.safeParse(value).success).toBe(ok);
  });

  test.each([
    [0, true],
    [1, true],
    [2, true],
    [3, true],
    [4, false],
    [-1, false],
    [1.5, false],
    ["2", false],
    [null, false],
  ] as const)("prioritySchema(%p)", (value, ok) => {
    expect(prioritySchema.safeParse(value).success).toBe(ok);
  });

  test.each([
    [1, true],
    [42, true],
    [0, false],
    [-3, false],
    [1.5, false],
    ["1", false],
    [null, false],
  ] as const)("positiveIdSchema(%p)", (value, ok) => {
    expect(positiveIdSchema.safeParse(value).success).toBe(ok);
  });
});

describe("scalar schemas", () => {
  test.each([
    ["a", true],
    ["A-b_9", true],
    [" alice ", true],
    ["a".repeat(64), true],
    ["", false],
    ["-abc", false],
    ["a b", false],
    ["café", false],
    ["a".repeat(65), false],
  ] as const)("handleSchema(%p)", (value, ok) => {
    expect(handleSchema.safeParse(value).success).toBe(ok);
  });

  test.each([
    ["#AABBCC", true],
    ["#AbC123", true],
    ["#000000", true],
    ["#ABC123", true],
    ["#AbC12", false],
    ["#AbC1234", false],
    ["AbC123", false],
    ["#GGHHII", false],
    ["", false],
  ] as const)("colorSchema(%p)", (value, ok) => {
    expect(colorSchema.safeParse(value).success).toBe(ok);
  });

  test.each([
    ["t", true],
    ["a".repeat(256), true],
    [" padded ", true],
    ["", false],
    ["   ", false],
    ["a".repeat(257), false],
  ] as const)("titleSchema(%p)", (value, ok) => {
    expect(titleSchema.safeParse(value).success).toBe(ok);
  });

  test.each([
    ["", true],
    ["a".repeat(100_000), true],
    ["a".repeat(100_001), false],
  ] as const)("bodySchema(%p length)", (value, ok) => {
    expect(bodySchema.safeParse(value).success).toBe(ok);
  });

  test.each([
    ["hello", true],
    ["  padded  ", true],
    ["", false],
    ["   ", false],
    ["\n\t", false],
    ["a".repeat(100_001), false],
  ] as const)("commentBodySchema(%p)", (value, ok) => {
    expect(commentBodySchema.safeParse(value).success).toBe(ok);
  });

  test.each([
    ["bug", true],
    ["a".repeat(64), true],
    ["", false],
    ["   ", false],
    ["a".repeat(65), false],
  ] as const)("labelNameSchema(%p)", (value, ok) => {
    expect(labelNameSchema.safeParse(value).success).toBe(ok);
  });

  test.each([
    ["bootstrap", true],
    ["a".repeat(128), true],
    ["", false],
    ["a".repeat(129), false],
  ] as const)("tokenNameSchema(%p)", (value, ok) => {
    expect(tokenNameSchema.safeParse(value).success).toBe(ok);
  });
});

describe("parseInput", () => {
  test("returns parsed and normalized data on success", () => {
    expect(parseInput(titleSchema, "  Hello  ")).toBe("Hello");
  });

  test("throws ValidationError with issue details on failure", () => {
    try {
      parseInput(titleSchema, "");
      throw new Error("parseInput should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.code).toBe("VALIDATION");
      const issues = validationError.details?.issues as Array<{ path: string; message: string }>;
      expect(Array.isArray(issues)).toBe(true);
      expect(issues.length).toBeGreaterThan(0);
      expect(typeof issues[0]?.message).toBe("string");
    }
  });
});
