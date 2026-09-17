import { describe, expect, test } from "bun:test";
import { reportUnexpectedError } from "../../../src/api/response";

function capture(run: () => void): string[] {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
  try {
    run();
  } finally {
    console.error = original;
  }
  return messages;
}

describe("reportUnexpectedError", () => {
  const requestId = "123e4567-e89b-42d3-a456-426614174000";

  test("records the correlation id with a bounded diagnostic", () => {
    const messages = capture(() => reportUnexpectedError(new Error("SQLITE_BUSY"), requestId));
    expect(messages).toEqual([
      `[api] unhandled error (request ${requestId}): Error: SQLITE_BUSY`,
    ]);
  });

  test("never records a stack trace or the raw error object", () => {
    const messages = capture(() => reportUnexpectedError(new Error("boom"), requestId));
    expect(messages.join(" ")).not.toContain("at ");
    expect(messages.join(" ")).not.toContain("[object Object]");
  });

  test("does not stringify a thrown non-Error value", () => {
    const secret = "wb_secret-private-request-content";
    const messages = capture(() => reportUnexpectedError({ body: secret }, requestId));
    expect(messages.join(" ")).not.toContain(secret);
    expect(messages).toEqual([`[api] unhandled error (request ${requestId}): object`]);
  });
});
