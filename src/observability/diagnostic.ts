// Bounded diagnostics for operator-facing failures.
//
// Two different problems are easy to conflate here:
//
//   * Request-derived data must never reach a log. Bodies, headers, item
//     content, MCP arguments, and query strings are collected nowhere, and no
//     amount of truncation makes them safe to record.
//   * An operator still has to be able to read why a process failed. Hiding an
//     `EADDRINUSE` behind "unexpected error" turns a one-line fix into a
//     debugging session.
//
// A bounded diagnostic serves the second need without weakening the first: it
// records only an error's class name and a single-line, length-capped message,
// never a stack and never the object itself. Errors that can carry request
// content are reported through fixed strings instead — see `mcpErrorResult`.

const MAX_DIAGNOSTIC_LENGTH = 200;

/**
 * Render an unexpected error as one bounded, single-line diagnostic.
 *
 * Control characters (including CR/LF) are replaced so a crafted message cannot
 * forge extra log lines, and the result is capped so a runaway message cannot
 * flood a terminal or a log sink.
 */
export function boundedDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const name = error.name === "" ? "Error" : error.name;
  const cleaned = error.message.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const message = cleaned.length > MAX_DIAGNOSTIC_LENGTH
    ? `${cleaned.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
    : cleaned;
  return message === "" ? name : `${name}: ${message}`;
}
