// Assembles the fetch handler: REST routes, auth, error mapping, SSE, the
// stateless /mcp endpoint, and optional embedded static assets for the web UI.
import { systemClock } from "../domain/types";
import type { Clock } from "../domain/types";
import type { AuthenticatedActor } from "../auth/service";
import type { WorkboardService } from "../app/workboard";
import type { WorkboardEventBroker } from "../app/events";
import { HttpRouter } from "./router";
import { registerItemRoutes } from "./items";
import { registerParticipantRoutes } from "./participants";
import { registerLabelRoutes } from "./labels";
import { registerEventsRoute } from "./events";
import { handleMcpRequest, MCP_ENDPOINT_PATH } from "./mcp-http";

export const DEFAULT_MAX_BODY_BYTES = 262_144; // 256 KiB

export interface StaticAsset {
  readonly body: string;
  readonly contentType: string;
}

export interface ApiHandlerDependencies {
  readonly service: WorkboardService;
  readonly broker: WorkboardEventBroker;
  // Transport dependency: resolves a presented credential to an actor.
  readonly authenticate: (credential: string | null | undefined, now: string) => AuthenticatedActor;
  readonly clock?: Clock;
  readonly maxBodyBytes?: number;
  readonly heartbeatMs?: number;
  /** Embedded web shell, keyed by path (e.g. "/", "/assets/app.js"). */
  readonly staticAssets?: Record<string, StaticAsset>;
}

export function createApiHandler(deps: ApiHandlerDependencies): (request: Request) => Promise<Response> {
  const clock: Clock = deps.clock ?? systemClock;
  const router = new HttpRouter(deps.authenticate, () => clock.now());
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  router.add("GET", "/api/health", (ctx) => {
    return new Response(JSON.stringify({ data: { status: "ok" } }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "X-Request-Id": ctx.requestId },
    });
  }, { auth: false });

  registerItemRoutes(router, { service: deps.service, maxBodyBytes });
  registerParticipantRoutes(router, { service: deps.service, maxBodyBytes });
  registerLabelRoutes(router, { service: deps.service, maxBodyBytes });
  registerEventsRoute(router, {
    broker: deps.broker,
    ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
  });

  return async (request: Request) => {
    const { pathname } = new URL(request.url);
    if (pathname === MCP_ENDPOINT_PATH) {
      return handleMcpRequest(
        {
          service: deps.service,
          authenticate: deps.authenticate,
          clock,
          ...(deps.maxBodyBytes !== undefined ? { maxBodyBytes: deps.maxBodyBytes } : {}),
        },
        request,
      );
    }
    if (pathname.startsWith("/api/")) return router.handle(request);

    const assets = deps.staticAssets;
    if (assets !== undefined) {
      const asset = pathname === "/" ? assets["/"] : assets[pathname];
      if (asset !== undefined) {
        return new Response(asset.body, {
          status: 200,
          headers: { "Content-Type": asset.contentType, "Cache-Control": "no-cache" },
        });
      }
    }
    return router.handle(request);
  };
}
