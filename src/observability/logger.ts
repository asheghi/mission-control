import type { WorkboardErrorCode } from "../domain/errors";

export type RequestTransport = "rest" | "mcp-http";
export type RequestOutcome = "ok" | WorkboardErrorCode | `HTTP_${number}`;

/** The complete allowlist for a request log record. */
export interface RequestLogRecord {
  readonly requestId: string;
  readonly transport: RequestTransport;
  readonly method: string;
  /** A query-free route pathname or canonical route pattern. */
  readonly pathname: string;
  /** Present only after successful authentication. */
  readonly participantId?: number;
  readonly durationMs: number;
  readonly status: number;
  readonly outcome: RequestOutcome;
}

/** Receives one complete JSON line, without a trailing newline. */
export type LogSink = (line: string) => void;

export interface Logger {
  logRequest(record: RequestLogRecord): void;
}

export interface DurationClock {
  nowMs(): number;
}

export interface LoggerOptions {
  readonly sink?: LogSink;
}

export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_METHOD_LENGTH = 16;
export const MAX_PATHNAME_LENGTH = 256;
export const MAX_DURATION_MS = 86_400_000;

const STATUS_BY_CODE: Readonly<Record<number, WorkboardErrorCode>> = {
  400: "VALIDATION",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  500: "INTERNAL",
};

export function httpStatusOutcome(status: number): RequestOutcome {
  if (status >= 200 && status < 300) return "ok";
  return STATUS_BY_CODE[status] ?? `HTTP_${boundedInteger(status, 100, 599, 500)}`;
}

function boundedText(value: string, maximum: number, fallback: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "");
  return cleaned.length === 0 ? fallback : cleaned.slice(0, maximum);
}

function boundedInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), minimum), maximum);
}

/**
 * Rebuilds the record from an explicit allowlist. Unknown properties on an
 * untyped caller are never serialized.
 */
export function normalizeRequestLogRecord(record: RequestLogRecord): RequestLogRecord {
  const participantId = Number.isSafeInteger(record.participantId) && (record.participantId ?? 0) > 0
    ? record.participantId
    : undefined;
  const status = boundedInteger(record.status, 100, 599, 500);

  return {
    requestId: boundedText(record.requestId, MAX_REQUEST_ID_LENGTH, "unavailable"),
    transport: record.transport === "mcp-http" ? "mcp-http" : "rest",
    method: boundedText(record.method.toUpperCase(), MAX_METHOD_LENGTH, "UNKNOWN"),
    pathname: boundedText(record.pathname, MAX_PATHNAME_LENGTH, "unknown"),
    ...(participantId !== undefined ? { participantId } : {}),
    durationMs: boundedInteger(record.durationMs, 0, MAX_DURATION_MS, 0),
    status,
    outcome: httpStatusOutcome(status),
  };
}

/** Production sink: one JSON object per stderr line. */
export function writeJsonLineToStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? writeJsonLineToStderr;
  return {
    logRequest(record): void {
      const line = JSON.stringify(normalizeRequestLogRecord(record));
      try {
        sink(line);
      } catch {
        // Logging must not change the response or emit a second, unsafe record.
      }
    },
  };
}
