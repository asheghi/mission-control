import { WorkboardError } from "../domain/errors";

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Convert a tool failure without collecting request-derived exception data.
 * Unexpected errors may carry tokens, MCP arguments, or work-item content in
 * their message and stack, so diagnostics must remain fixed and bounded.
 */
export function mcpErrorResult(error: unknown, log: (message: string) => void = console.error): McpToolResult {
  const expected = error instanceof WorkboardError;
  if (!expected) log("[mcp] unexpected tool error");
  return {
    content: [{ type: "text", text: expected ? error.message : "The request could not be completed." }],
    isError: true,
  };
}
