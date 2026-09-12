// Minimal Bun-native HTTP router. Transport independence rule: this module
// only adapts HTTP to the application service; all business logic lives in
// WorkboardService.
import type { Actor } from "../domain/types";
import type { AuthenticatedActor } from "../auth/service";
import { bearerToken } from "../auth/middleware";
import { ValidationError } from "../domain/errors";
import {
  createRequestLogContext,
  createRequestLogObserver,
  finishRequest,
  setRequestParticipant,
} from "../observability/request-log";
import type { RequestLogObserver } from "../observability/request-log";
import { discardUnexpectedError, jsonError, mapErrorWithReport, methodNotAllowed } from "./response";

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

/**
 * Route pattern only: a raw pathname would put item ids — or any stray path
 * text a caller invents — into the log. Unmatched paths collapse to this fixed
 * marker so the same 404 shape always logs the same way.
 */
const UNMATCHED_PATH = "/<unmatched>";

export class HttpRouter {
  private readonly routes: CompiledRoute[] = [];

  constructor(
    private readonly authenticate: Authenticator,
    private readonly now: () => string,
    /** Optional injection; defaults to the production stderr observer. */
    private readonly observer: RequestLogObserver = createRequestLogObserver(),
  ) {}

  add(method: string, path: string, handler: RouteHandler, options: RegisterOptions = {}): void {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    this.routes.push({ method: method.toUpperCase(), segments, handler, requiresAuth: options.auth !== false });
  }

  async handle(request: Request): Promise<Response> {
    // One context and one timer per request. Its request id comes from the same
    // header this router echoes back, so the logged id is the one the caller saw.
    const context = createRequestLogContext(request, this.observer.clock);
    const requestId = context.requestId();
    const url = new URL(request.url);
    const pathSegments = url.pathname.split("/").filter((segment) => segment.length > 0);

    // Filled in by whichever branch below produces the response; the observer
    // records exactly one bounded line from it at the single exit.
    const returnWith = (response: Response, pathname: string): Response => {
      response.headers.set("X-Request-Id", requestId);
      finishRequest(this.observer, context, {
        transport: "rest",
        method: request.method,
        pathname,
        status: response.status,
      });
      return response;
    };

    let pathExists = false;
    let matchedPathname: string | undefined;
    const allowMethods = new Set<string>();

    for (const route of this.routes) {
      let params: Record<string, string> | null;
      try {
        params = matchSegments(route.segments, pathSegments);
      } catch (error) {
        // A malformed percent-escape in a matched path shape is a client
        // error, not an internal one — report it in the standard envelope.
        if (error instanceof ValidationError) {
          return returnWith(jsonError("VALIDATION", error.message, requestId), patternFor(route));
        }
        throw error;
      }
      if (params === null) continue;
      pathExists = true;
      matchedPathname ??= patternFor(route);
      allowMethods.add(route.method);
      if (route.method !== request.method) continue;

      const pattern = patternFor(route);
      try {
        const actor = route.requiresAuth
          ? this.authenticate(bearerToken(request), this.now())
          : ANONYMOUS_ACTOR;
        // Authentication succeeded; the anonymous actor (participant 0) is
        // recorded as absent, so the field means "authenticated participant".
        setRequestParticipant(context, actor.participantId);
        const response = await route.handler({ request, url, params, requestId, actor });
        return returnWith(response, pattern);
      } catch (error) {
        // Expected failures are mapped (and recorded) here; an unexpected one
        // is also reported through the observer's diagnostic sink instead of
        // the process-wide stderr report, keeping exactly one record per request.
        const response = mapErrorWithReport(error, requestId, discardUnexpectedError);
        return returnWith(response, pattern);
      }
    }

    // Every exit below records exactly once: a throw out of a route handler is
    // a bug, and one bounded line still has to describe the request.
    try {
      if (pathExists) {
        const response = methodNotAllowed([...allowMethods].sort(), requestId);
        return returnWith(response, matchedPathname ?? UNMATCHED_PATH);
      }
      const response = jsonError("NOT_FOUND", "The requested resource was not found.", requestId);
      return returnWith(response, UNMATCHED_PATH);
    } catch (error) {
      // A failure while shaping an error response, and a malformed request URL
      // (the `new URL` above is outside this block) would otherwise escape
      // unrecorded.
      const response = mapErrorWithReport(error, requestId, discardUnexpectedError);
      return returnWith(response, matchedPathname ?? UNMATCHED_PATH);
    }
  }
}

function patternFor(route: CompiledRoute): string {
  return `/${route.segments.join("/")}`;
}

function matchSegments(routeSegments: readonly string[], pathSegments: readonly string[]): Record<string, string> | null {
  if (routeSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (const [index, routeSegment] of routeSegments.entries()) {
    const pathSegment = pathSegments[index];
    if (pathSegment === undefined) return null;
    if (routeSegment.startsWith(":")) {
      const raw = routeSegment.slice(1);
      try {
        params[raw] = decodeURIComponent(pathSegment);
      } catch {
        // The raw segment is deliberately not echoed: it is unvalidated caller
        // input, and the request record must stay bounded and free of path text.
        throw new ValidationError("Malformed percent-encoding in a path segment.");
      }
    } else if (routeSegment !== pathSegment) {
      return null;
    }
  }
  return params;
}
