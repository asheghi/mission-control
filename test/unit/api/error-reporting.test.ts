import { describe, expect, test } from "bun:test";
import { reportUnexpectedError } from "../../../src/api/response";

describe("reportUnexpectedError", () => {
  test("does not collect raw exception content", () => {
    const secret = "wb_secret-private-request-content";
    const messages: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
    try {
      reportUnexpectedError(new Error(secret), "123e4567-e89b-42d3-a456-426614174000");
    } finally {
      console.error = original;
    }

    expect(messages).toEqual([
      "[api] unhandled error (request 123e4567-e89b-42d3-a456-426614174000)",
    ]);
    expect(messages.join(" ")).not.toContain(secret);
  });
});
