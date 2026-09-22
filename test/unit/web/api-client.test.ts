// Unit tests for the browser API client's event-stream contract.
//
// The live feed only reconnects if it is told the stream ended, so the exact
// callback sequence matters: an aborted (closed) stream must still report a
// normal close, while a genuine failure must report an error the app can
// classify. The client reads localStorage, so a minimal stub stands in.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as apiModule from "../../../src/web/api.js";

// The client is a plain browser asset embedded as text, so the server build
// sees only a string. This suite declares the surface it exercises; every
// member is verified at runtime below.
interface StreamHandlers {
  onEvent?: (event: { event: string; data: string; raw: string }) => void;
  onComment?: (raw: string) => void;
  onClose?: () => void;
  onError?: (error: unknown) => void;
}

interface ApiClient {
  ApiError: new (code: string, message: string, status: number, details?: unknown) => Error & { status: number };
  getToken(): string | null;
  setToken(token: string | null): void;
  consumeTokenFromHash(hash?: string): string | null;
  subscribeEvents(handlers: StreamHandlers, signal?: AbortSignal): { close(): void };
}

const api = apiModule as unknown as ApiClient;

// --- stubs -------------------------------------------------------------------

interface Stub {
  readonly map: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let stub: Stub;

beforeEach(() => {
  const map = new Map<string, string>();
  stub = {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
  (globalThis as any).localStorage = stub;
  (globalThis as any).sessionStorage = stub;
  api.setToken("wb_test_token");
});

afterEach(() => {
  delete (globalThis as any).localStorage;
  delete (globalThis as any).sessionStorage;
  delete (globalThis as any).fetch;
});

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as any).fetch = realFetch;
});

/** A response whose body stays open until the test ends it. */
function openStream() {
  let closeBody: () => void = () => {};
  let abortBody: (error: unknown) => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      closeBody = () => controller.close();
      abortBody = (error) => controller.error(error);
    },
  });
  return { response: new Response(body, { status: 200 }), closeBody: () => closeBody(), abortBody: (e: unknown) => abortBody(e) };
}

type FetchHandler = (input: string, init?: RequestInit) => Promise<Response>;

function stubFetch(handler: FetchHandler) {
  const calls: { url: string; headers: Record<string, string>; signal: AbortSignal | null }[] = [];
  const fetchStub = (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: (init?.signal as AbortSignal | undefined) ?? null,
    });
    return handler(String(input), init);
  };
  (globalThis as any).fetch = fetchStub;
  return calls;
}

function tick(times = 6): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) chain = chain.then(() => new Promise<void>((resolve) => setTimeout(resolve, 1)));
  return chain;
}

// --- tests -------------------------------------------------------------------

describe("subscribeEvents", () => {
  test("exposes the documented client surface", () => {
    expect(typeof api.subscribeEvents).toBe("function");
    expect(typeof api.setToken).toBe("function");
    expect(typeof api.getToken).toBe("function");
    expect(typeof api.ApiError).toBe("function");
  });

  test("sends the bearer token and reads event frames", async () => {
    const encoder = new TextEncoder();
    const calls = stubFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('event: item.updated\ndata: {"id":4}\n\n'));
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );

    const events: string[] = [];
    const comments: string[] = [];
    let closed = 0;
    api.subscribeEvents({
      onEvent: (event) => events.push(event.event),
      onComment: (raw) => comments.push(raw),
      onClose: () => {
        closed += 1;
      },
    });
    await tick();

    expect(calls[0]?.url).toBe("/api/events");
    expect(calls[0]?.headers.Authorization).toBe("Bearer wb_test_token");
    expect(calls[0]?.headers.Accept).toBe("text/event-stream");
    expect(events).toEqual(["item.updated"]);
    expect(comments).toEqual([": heartbeat"]);
    expect(closed).toBe(1); // the server ended the stream normally
  });

  test("close() reports a normal end of stream, so the caller can react", async () => {
    const stream = openStream();
    stubFetch(async () => stream.response);

    let closed = 0;
    const errors: unknown[] = [];
    const handle = api.subscribeEvents({
      onClose: () => {
        closed += 1;
      },
      onError: (error) => errors.push(error),
    });
    await tick();

    handle.close();
    stream.abortBody(new DOMException("The operation was aborted.", "AbortError"));
    await tick();

    // Regression: an aborted read used to reject into the `aborted` guard and
    // notify nobody, leaving the app blind to its own dead stream.
    expect(closed).toBe(1);
    expect(errors).toEqual([]);
  });

  test("a transport failure reports the error instead of a close", async () => {
    const stream = openStream();
    stubFetch(async () => stream.response);

    let closed = 0;
    const errors: unknown[] = [];
    api.subscribeEvents({
      onClose: () => {
        closed += 1;
      },
      onError: (error) => errors.push(error),
    });
    await tick();

    stream.abortBody(new TypeError("network error"));
    await tick();

    expect(closed).toBe(0);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("network error");
  });

  test("a rejected fetch reports an error", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    const errors: unknown[] = [];
    api.subscribeEvents({ onError: (error) => errors.push(error) });
    await tick();

    expect(errors).toHaveLength(1);
  });

  test("a non-OK stream response reports an ApiError carrying the status", async () => {
    stubFetch(async () => new Response("nope", { status: 401 }));

    let closed = 0;
    const errors: unknown[] = [];
    api.subscribeEvents({
      onClose: () => {
        closed += 1;
      },
      onError: (error) => errors.push(error),
    });
    await tick();

    expect(closed).toBe(0);
    expect(errors).toHaveLength(1);
    const error = errors[0] as { status?: number; name?: string };
    expect(error.name).toBe("ApiError");
    expect(error.status).toBe(401); // the app treats this as terminal
  });

  test("missing handlers never throw", async () => {
    stubFetch(async () => new Response("nope", { status: 500 }));
    expect(() => api.subscribeEvents({})).not.toThrow();
    await tick();
  });

  test("an external AbortSignal closes the stream", async () => {
    const stream = openStream();
    stubFetch(async (_input, init) => {
      init?.signal?.addEventListener("abort", () => stream.abortBody(new DOMException("aborted", "AbortError")));
      return stream.response;
    });

    const controller = new AbortController();
    let closed = 0;
    api.subscribeEvents({ onClose: () => (closed += 1) }, controller.signal);
    await tick();

    controller.abort();
    await tick();
    expect(closed).toBe(1);
  });

  // Regression: an already-aborted signal never fires "abort" again, so
  // subscribing to it merely registered a listener that could never run — the
  // stream started anyway and the caller's cancellation was silently ignored.
  test("an already-aborted external signal never starts the stream", async () => {
    const calls = stubFetch(async () => new Response("should not be requested", { status: 200 }));

    const controller = new AbortController();
    controller.abort(); // aborted BEFORE subscribeEvents is called

    let closed = 0;
    const errors: unknown[] = [];
    api.subscribeEvents(
      {
        onClose: () => {
          closed += 1;
        },
        onError: (error) => errors.push(error),
      },
      controller.signal,
    );
    await tick();

    expect(calls).toEqual([]); // no request was made at all
    expect(errors).toEqual([]);
    // The caller is still told its subscription ended, exactly once, so the
    // app can distinguish "cancelled" from "never reported anything".
    expect(closed).toBe(1);
  });

  test("close() on an already-aborted subscription is reported once, not twice", async () => {
    stubFetch(async () => new Response("unused", { status: 200 }));

    const controller = new AbortController();
    controller.abort();

    let closed = 0;
    const handle = api.subscribeEvents({ onClose: () => (closed += 1) }, controller.signal);
    await tick();
    expect(closed).toBe(1);

    handle.close(); // aborting again must not emit a second terminal callback
    await tick();
    expect(closed).toBe(1);
  });

  test("a normal stream still reports exactly one close", async () => {
    const encoder = new TextEncoder();
    stubFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('event: item.updated\ndata: {"id":1}\n\n'));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );

    let closed = 0;
    let errors = 0;
    api.subscribeEvents({
      onClose: () => {
        closed += 1;
      },
      onError: () => {
        errors += 1;
      },
    });
    await tick();

    expect(closed).toBe(1); // the new `finished` guard must not double-report
    expect(errors).toBe(0);
  });
});

// --- development auto-login fragment ----------------------------------------

// A `#token=...` link is how `bun run dev:board` signs a developer in. The
// parsing is load-bearing: the token ends at the NEXT "#", and getting that
// wrong stores a token the server rejects while also losing the route the link
// asked for — a silent sign-in failure with no visible cause.
describe("consumeTokenFromHash", () => {
  let replaced: string[];

  beforeEach(() => {
    replaced = [];
    (globalThis as any).location = { pathname: "/", search: "", hash: "" };
    (globalThis as any).history = {
      state: null,
      replaceState: (_state: unknown, _title: string, url: string) => {
        replaced.push(url);
        const i = url.indexOf("#");
        (globalThis as any).location.hash = i === -1 ? "" : url.slice(i);
      },
    };
  });

  afterEach(() => {
    delete (globalThis as any).location;
    delete (globalThis as any).history;
  });

  test("adopts the token and strips it from the URL", () => {
    const result = api.consumeTokenFromHash("#token=wb_abc123");
    expect(result).toBe("wb_abc123");
    expect(api.getToken()).toBe("wb_abc123");
    expect(replaced).toEqual(["/"]);
  });

  test("the token ends at the next #, so the route survives", () => {
    const result = api.consumeTokenFromHash("#token=wb_abc123#/list?type=bug");
    expect(result).toBe("wb_abc123");
    expect(api.getToken()).toBe("wb_abc123");
    // The route must be restored, and must NOT have been swallowed into the token.
    expect(replaced).toEqual(["/#/list?type=bug"]);
    expect(api.getToken()).not.toContain("#");
  });

  test("a token with no route leaves a clean path", () => {
    expect(api.consumeTokenFromHash("#token=wb_abc")).toBe("wb_abc");
    expect(replaced).toEqual(["/"]);
  });

  test("anything that is not a token fragment is ignored", () => {
    for (const hash of ["#/backlog", "#/item/3", "", "#token=", "#tokenX=abc"]) {
      const before = api.getToken();
      expect(api.consumeTokenFromHash(hash), hash).toBeNull();
      expect(api.getToken(), hash).toBe(before);
    }
    expect(replaced).toEqual([]);
  });

  test("a failed URL rewrite refuses the token rather than leaving it in the bar", () => {
    (globalThis as any).history.replaceState = () => {
      throw new Error("blocked");
    };
    api.setToken(null);
    expect(api.consumeTokenFromHash("#token=wb_leaky")).toBeNull();
    expect(api.getToken()).toBeNull();
  });
});
