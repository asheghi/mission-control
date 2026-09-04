// GET /api/events — Server-Sent Events for live board updates.
//
// Browsers cannot send Authorization headers with EventSource, so clients use
// a fetch-stream reader (which can). Tokens never appear in URLs.
// The broker enforces per-subscriber queue bounds; when it disconnects a slow
// subscriber this route tears the stream down. A heartbeat comment keeps
// intermediaries from idling the connection out.
import type { WorkboardEvent, WorkboardEventBroker } from "../app/events";
import type { HttpRouter } from "./router";

export interface EventRouteDeps {
  readonly broker: WorkboardEventBroker;
  readonly heartbeatMs?: number;
}

export const DEFAULT_HEARTBEAT_MS = 15_000;

export function registerEventsRoute(router: HttpRouter, deps: EventRouteDeps): void {
  router.add("GET", "/api/events", (ctx) => {
    const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const encoder = new TextEncoder();

    let unsubscribe: () => void = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;

    // High-water mark 64: allow a bounded backlog of chunks before the
    // slow-consumer disconnect in send() engages. The default strategy (1)
    // would trip on the very first chunk of a healthy stream.
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          const send = (chunk: string): void => {
            if (closed) return;
            controller.enqueue(encoder.encode(chunk));
            // enqueue() never throws for a slow consumer — it buffers. Treat a
            // non-positive desiredSize as a stalled reader and disconnect, so
            // the broker's bounded-queue guarantee holds at the last hop too.
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              cleanup();
            }
          };
          const cleanup = (): void => {
            if (closed) return;
            closed = true;
            if (heartbeat !== undefined) clearInterval(heartbeat);
            unsubscribe();
            try {
              controller.close();
            } catch {
              // Already closed by the runtime on client disconnect.
            }
          };

          ctx.request.signal.addEventListener("abort", cleanup);
          send(": connected\n\n");

          unsubscribe = deps.broker.subscribe(
            (event) => {
              try {
                send(formatSseEvent(event));
              } catch {
                cleanup();
              }
            },
            cleanup, // broker overflow/close disconnects this consumer
          );

          heartbeat = setInterval(() => {
            try {
              send(": heartbeat\n\n");
            } catch {
              cleanup();
            }
          }, heartbeatMs);
        },
        cancel: () => {
          closed = true;
          if (heartbeat !== undefined) clearInterval(heartbeat);
          unsubscribe();
        },
      },
      { highWaterMark: 64 },
    );

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });
}

export function formatSseEvent(event: WorkboardEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
