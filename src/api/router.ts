// Minimal Bun-native HTTP router. Transport independence rule: this module
// only adapts HTTP to the application service; all business logic lives in
// WorkboardService.
import type { Actor } from "../domain/types";
import type { AuthenticatedActor } from "../auth/service";
import { bearerToken } from "../auth/middleware";
import { jsonError, mapError, methodNotAllowed } from "./response";

export interface RouteContext {
  readonly request: Request;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly requestId: string;
  readonly actor: Actor;
}

export type RouteHandler = (ctx: RouteContext) => Response | Promise<Response>;

export type Authenticator = (credential: string | null | undefined, now: string) => AuthenticatedActor;

export interface RegisterOptions {
  /** Defaults to true; set false only for health/static routes. */
  readonly auth?: boolean;
}

interface CompiledRoute {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
  readonly requiresAuth: boolean;
}

const ANONYMOUS_ACTOR: Actor = { participantId: 0, name: "anonymous", kind: "human" };

export class HttpRouter {
  private readonly routes: CompiledRoute[] = [];

  constructor(
    private readonly authenticate: Authenticator,
    private readonly now: () => string,
  ) {}

  add(method: string, path: string, handler: RouteHandler, options: RegisterOptions = {}): void {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    this.routes.push({ method: method.toUpperCase(), segments, handler, requiresAuth: options.auth !== false });
  }

  async handle(request: Request): Promise<Response> {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    const url = new URL(request.url);
    const pathSegments = url.pathname.split("/").filter((segment) => segment.length > 0);

    let pathExists = false;
    const allowMethods = new Set<string>();

    for (const route of this.routes) {
      const params = matchSegments(route.segments, pathSegments);
      if (params === null) continue;
      pathExists = true;
      allowMethods.add(route.method);
      if (route.method !== request.method) continue;

      try {
        const actor = route.requiresAuth
          ? this.authenticate(bearerToken(request), this.now())
          : ANONYMOUS_ACTOR;
        const response = await route.handler({ request, url, params, requestId, actor });
        response.headers.set("X-Request-Id", requestId);
        return response;
      } catch (error) {
        return withRequestId(mapError(error, requestId), requestId);
      }
    }

    if (pathExists) {
      return withRequestId(methodNotAllowed([...allowMethods].sort(), requestId), requestId);
    }
    return withRequestId(jsonError("NOT_FOUND", "The requested resource was not found.", requestId), requestId);
  }
}

function withRequestId(response: Response, requestId: string): Response {
  response.headers.set("X-Request-Id", requestId);
  return response;
}

function matchSegments(routeSegments: readonly string[], pathSegments: readonly string[]): Record<string, string> | null {
  if (routeSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (const [index, routeSegment] of routeSegments.entries()) {
    const pathSegment = pathSegments[index];
    if (pathSegment === undefined) return null;
    if (routeSegment.startsWith(":")) {
      params[routeSegment.slice(1)] = decodeURIComponent(pathSegment);
    } else if (routeSegment !== pathSegment) {
      return null;
    }
  }
  return params;
}
