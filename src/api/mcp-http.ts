// Stateless Streamable HTTP MCP endpoint at /mcp (plan decision: 2025-era
// stateless pattern — a fresh McpServer + transport per POST, sessions
// disabled, GET/DELETE rejected). The installed SDK generation (1.30.0)
// negotiates the 2025-11-25 protocol revision, matching the DSH bridge.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Clock } from "../domain/types";
import { systemClock } from "../domain/types";
import { ForbiddenError } from "../domain/errors";
import type { WorkboardService } from "../app/workboard";
import { bearerToken } from "../auth/middleware";
import type { Authenticator } from "./router";
import { jsonError, mapError, readBodyText } from "./response";
import { buildMcpServer } from "../mcp/tools";

export const MCP_ENDPOINT_PATH = "/mcp";
export const DEFAULT_MCP_MAX_BODY_BYTES = 1_000_000;

const LOOPBACK_ORIGIN_PATTERN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export interface McpHttpDependencies {
  readonly service: WorkboardService;
  readonly authenticate: Authenticator;
  readonly clock?: Clock;
  readonly maxBodyBytes?: number;
}

/** Browsers and same-origin UIs on loopback are allowed; everything else with an Origin is refused. */
export function isAllowedOrigin(origin: string): boolean {
  return LOOPBACK_ORIGIN_PATTERN.test(origin);
}

export async function handleMcpRequest(deps: McpHttpDependencies, request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const withRequestId = (response: Response): Response => {
    response.headers.set("X-Request-Id", requestId);
    return response;
  };

  try {
    if (request.method !== "POST") {
      // Stateless: no SSE listening (GET) and no session to terminate (DELETE).
      const response = jsonError("METHOD_NOT_ALLOWED", "The MCP endpoint accepts POST only.", requestId);
      response.headers.set("Allow", "POST");
      return response;
    }

    const origin = request.headers.get("origin");
    if (origin !== null && !isAllowedOrigin(origin)) {
      throw new ForbiddenError("This origin is not allowed to use the MCP endpoint.");
    }

    // Authenticate before consuming the body: an unauthenticated caller gets
    // 401 without the server ever buffering its payload.
    const actor = deps.authenticate(bearerToken(request), (deps.clock ?? systemClock).now());

    // Stream the body under a hard byte cap (readBodyText aborts past the
    // limit), and count bytes — not UTF-16 code units — against maxBytes.
    const maxBytes = deps.maxBodyBytes ?? DEFAULT_MCP_MAX_BODY_BYTES;
    const raw = await readBodyText(request, maxBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsonError("VALIDATION", "Malformed JSON body.", requestId);
    }

    // Stateless 2025-era pattern (proven by the Task 1 spike): a fresh server
    // and transport per POST; the absent sessionIdGenerator disables session
    // management, so no MCP-Session-Id is ever issued.
    const mcpServer = buildMcpServer(deps.service, actor);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    request.signal.addEventListener("abort", () => {
      void transport.close();
      void mcpServer.close();
    });
    await mcpServer.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody: parsed });
    void transport.close();
    void mcpServer.close();
    return withRequestId(response);
  } catch (error) {
    return withRequestId(mapError(error, requestId));
  }
}
