import { describe, expect, test } from "bun:test";
import {
  MAX_DURATION_MS,
  MAX_PATHNAME_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  createLogger,
  httpStatusOutcome,
  normalizeRequestLogRecord,
} from "../../../src/observability/logger";
import {
  createRequestLogContext,
  createRequestLogObserver,
  finishRequest,
  requestIdOf,
  setRequestParticipant,
} from "../../../src/observability/request-log";

describe("request observability", () => {
  test("emits one allowlisted JSON line per context", () => {
    const lines: string[] = [];
    let now = 10;
    const observer = createRequestLogObserver({
      logger: createLogger({ sink: (line) => lines.push(line) }),
      clock: { nowMs: () => now },
    });
    const context = createRequestLogContext(new Request("http://127.0.0.1/api/items?q=secret"), observer.clock);
    setRequestParticipant(context, 7);
    now = 25;
    const input = { transport: "rest" as const, method: "GET", pathname: "/api/items", status: 200 };
    finishRequest(observer, context, input);
    finishRequest(observer, context, input);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      requestId: context.requestId(), transport: "rest", method: "GET", pathname: "/api/items",
      participantId: 7, durationMs: 15, status: 200, outcome: "ok",
    });
  });

  test("omits unauthenticated participant and derives stable outcomes", () => {
    const lines: string[] = [];
    const observer = createRequestLogObserver({
      logger: createLogger({ sink: (line) => lines.push(line) }),
      clock: { nowMs: () => 0 },
    });
    const context = createRequestLogContext(new Request("http://127.0.0.1/api/items"), observer.clock);
    finishRequest(observer, context, { transport: "rest", method: "GET", pathname: "/api/items", status: 401 });
    const record = JSON.parse(lines[0] ?? "{}");
    expect(record.outcome).toBe("UNAUTHENTICATED");
    expect("participantId" in record).toBe(false);
    expect(httpStatusOutcome(500)).toBe("INTERNAL");
    expect(httpStatusOutcome(418)).toBe("HTTP_418");
  });

  test("bounds fields, strips controls, and clamps duration", () => {
    const record = normalizeRequestLogRecord({
      requestId: `bad\r\n${"x".repeat(300)}`,
      transport: "mcp-http",
      method: "post-with-untrusted-suffix",
      pathname: `/${"p".repeat(400)}`,
      durationMs: Number.MAX_SAFE_INTEGER,
      status: 200,
      outcome: "ok",
    });
    expect(record.requestId.length).toBeLessThanOrEqual(MAX_REQUEST_ID_LENGTH);
    expect(record.pathname.length).toBeLessThanOrEqual(MAX_PATHNAME_LENGTH);
    expect(record.durationMs).toBe(MAX_DURATION_MS);
    expect(JSON.stringify(record)).not.toContain("\n");
    expect(JSON.stringify(record)).not.toContain("\r");
  });

  test("never serializes unknown credential or body fields", () => {
    const sentinel = "wb_SECRET_SENTINEL";
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });
    logger.logRequest({
      requestId: "r", transport: "rest", method: "POST", pathname: "/api/items",
      participantId: 2, durationMs: 1, status: 201, outcome: "ok",
      ...({ authorization: `Bearer ${sentinel}`, body: sentinel, query: sentinel } as object),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(sentinel);
    expect(Object.keys(JSON.parse(lines[0] ?? "{}")).sort()).toEqual([
      "durationMs", "method", "outcome", "participantId", "pathname", "requestId", "status", "transport",
    ]);
  });

  test("accepts only canonical UUID request ids and replaces unsafe header content", () => {
    const safe = "123e4567-e89b-42d3-a456-426614174000";
    expect(requestIdOf(new Request("http://127.0.0.1/api/health", { headers: { "x-request-id": safe } }))).toBe(safe);

    const sentinel = "wb_SECRET_SENTINEL";
    const generated = requestIdOf(new Request("http://127.0.0.1/api/health", { headers: { "x-request-id": sentinel } }));
    expect(generated).not.toContain(sentinel);
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("logging sink failures never affect request flow", () => {
    const logger = createLogger({ sink: () => { throw new Error("sink failed"); } });
    expect(() => logger.logRequest({
      requestId: "r", transport: "rest", method: "GET", pathname: "/api/health",
      durationMs: 0, status: 200, outcome: "ok",
    })).not.toThrow();
  });
});
