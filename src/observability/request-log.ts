import { createLogger, httpStatusOutcome } from "./logger";
import type { DurationClock, Logger, RequestLogRecord, RequestTransport } from "./logger";

/** Monotonic time source used only for elapsed request duration. */
export const monotonicDurationClock: DurationClock = {
  nowMs: () => performance.now(),
};

export interface RequestLogObserver {
  readonly logger: Logger;
  readonly clock: DurationClock;
}

export interface RequestLogObserverOptions {
  readonly logger?: Logger;
  readonly clock?: DurationClock;
}

export function createRequestLogObserver(options: RequestLogObserverOptions = {}): RequestLogObserver {
  return {
    logger: options.logger ?? createLogger(),
    clock: options.clock ?? monotonicDurationClock,
  };
}

export interface RequestLogContext {
  requestId(): string;
  participantId(): number | undefined;
}

interface RequestState {
  readonly requestId: string;
  readonly startedAtMs: number;
  participantId?: number;
  emitted: boolean;
}

const states = new WeakMap<RequestLogContext, RequestState>();

const SAFE_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requestIdOf(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  // Request ids cross the log boundary. Accept only a canonical UUID; arbitrary
  // header text could itself be a credential or user content. Unsafe values are
  // replaced rather than sanitized after they have entered the record.
  return supplied !== undefined && SAFE_REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();
}

export function createRequestLogContext(request: Request, clock: DurationClock): RequestLogContext {
  const context: RequestLogContext = {
    requestId: () => stateOf(context).requestId,
    participantId: () => stateOf(context).participantId,
  };
  states.set(context, {
    requestId: requestIdOf(request),
    startedAtMs: clock.nowMs(),
    emitted: false,
  });
  return context;
}

/** Set only after authenticate returned an actor. */
export function setRequestParticipant(context: RequestLogContext, participantId: number): void {
  if (Number.isSafeInteger(participantId) && participantId > 0) {
    stateOf(context).participantId = participantId;
  }
}

function stateOf(context: RequestLogContext): RequestState {
  const state = states.get(context);
  if (state === undefined) throw new Error("Unknown request log context.");
  return state;
}

function elapsedMs(startedAtMs: number, clock: DurationClock): number {
  const elapsed = clock.nowMs() - startedAtMs;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

export interface FinishRequestInput {
  readonly transport: RequestTransport;
  readonly method: string;
  readonly pathname: string;
  readonly status: number;
}

/**
 * Emits at most once for this context, even if a future transport branch
 * accidentally attempts to finish the same request twice.
 */
export function finishRequest(
  observer: RequestLogObserver,
  context: RequestLogContext,
  input: FinishRequestInput,
): void {
  const state = stateOf(context);
  if (state.emitted) return;
  state.emitted = true;

  const record: RequestLogRecord = {
    requestId: state.requestId,
    transport: input.transport,
    method: input.method,
    pathname: input.pathname,
    ...(state.participantId !== undefined ? { participantId: state.participantId } : {}),
    durationMs: elapsedMs(state.startedAtMs, observer.clock),
    status: input.status,
    outcome: httpStatusOutcome(input.status),
  };
  observer.logger.logRequest(record);
}
