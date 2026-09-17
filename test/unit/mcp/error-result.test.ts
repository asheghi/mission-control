import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../../src/domain/errors";
import { mcpErrorResult } from "../../../src/mcp/error-result";

describe("mcpErrorResult", () => {
  test("returns expected public domain errors without diagnostics", () => {
    const logs: string[] = [];
    const result = mcpErrorResult(new ValidationError("Input validation failed."), (message) => logs.push(message));

    expect(result).toEqual({
      content: [{ type: "text", text: "Input validation failed." }],
      isError: true,
    });
    expect(logs).toEqual([]);
  });

  test("never logs or returns raw unexpected error content", () => {
    const secret = "wb_secret-and-private-item-text";
    const logs: string[] = [];
    const result = mcpErrorResult(new Error(secret), (message) => logs.push(message));

    expect(result).toEqual({
      content: [{ type: "text", text: "The request could not be completed." }],
      isError: true,
    });
    expect(logs).toEqual(["[mcp] unexpected tool error"]);
    expect(JSON.stringify({ result, logs })).not.toContain(secret);
  });
});
