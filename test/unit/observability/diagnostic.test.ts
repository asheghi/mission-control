import { describe, expect, test } from "bun:test";
import { boundedDiagnostic } from "../../../src/observability/diagnostic";

describe("boundedDiagnostic", () => {
  test("keeps the class name and message an operator needs", () => {
    const error = Object.assign(new Error("Failed to start server on port 8765"), { name: "Error", code: "EADDRINUSE" });
    expect(boundedDiagnostic(error)).toBe("Error: Failed to start server on port 8765");
  });

  test("caps the message so a runaway error cannot flood a log", () => {
    const rendered = boundedDiagnostic(new Error("x".repeat(5000)));
    expect(rendered.length).toBeLessThanOrEqual(210);
    expect(rendered).toEndWith("…");
  });

  test("replaces control characters so a message cannot forge log lines", () => {
    const rendered = boundedDiagnostic(new Error("first\nsecond\r\nthird"));
    expect(rendered).toBe("Error: first second  third");
    expect(rendered).not.toContain("\n");
    expect(rendered).not.toContain("\r");
  });

  test("falls back to the class name for an empty message", () => {
    expect(boundedDiagnostic(new Error(""))).toBe("Error");
  });

  test("names a non-Error value by type instead of stringifying it", () => {
    // A thrown object can carry request data; only its type is reported.
    expect(boundedDiagnostic({ secret: "wb_private" })).toBe("object");
    expect(boundedDiagnostic(undefined)).toBe("undefined");
  });
});
