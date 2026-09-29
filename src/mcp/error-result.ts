import { WorkboardError } from "../domain/errors";

/**
 * A tool result.
 *
 * Text is the norm. An `image` block is allowed because a model that can see a
 * screenshot attached to a bug report is materially more useful than one handed
 * a URL it cannot fetch — but only for small raster images, never video, and
 * never as a way to move arbitrary bytes through a JSON tool call.
 */
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type McpToolResult = {
  content: McpContentBlock[];
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
