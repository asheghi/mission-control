// Assembles the REST API fetch handler: routes, auth, error mapping, SSE.
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

export const DEFAULT_MAX_BODY_BYTES = 262_144; // 256 KiB

export interface ApiHandlerDependencies {
  readonly service: WorkboardService;
  readonly broker: WorkboardEventBroker;
  // Transport dependency: resolves a presented credential to an actor.
  readonly authenticate: (credential: string | null | undefined, now: string) => AuthenticatedActor;
  readonly clock?: Clock;
  readonly maxBodyBytes?: number;
  readonly heartbeatMs?: number;
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

  return (request: Request) => router.handle(request);
}
