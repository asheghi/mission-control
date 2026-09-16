// Focused unit tests for the detail feature's settled-burst serializer.
//
// `queue.ts` is pure — no DOM, no fetch, no timers — so its exact scheduling
// contract can be driven directly and deterministically. The three properties
// below are the ones the detail view depends on and the ones a naive
// implementation gets wrong:
//
//   1. a synchronous burst runs its FIRST and its LAST value, not just one;
//   2. a failed write never blocks the drain and never leaks an unhandled
//      rejection to a caller that does not await;
//   3. a caller settles when its own value is performed or superseded, never
//      after unrelated later work.
import { describe, expect, test } from "bun:test";
import { createSettledBurstQueue } from "../../../src/web/features/detail/queue";

/** A `perform` whose completions are driven by the test, one release at a time. */
function controllablePerform(): {
  perform: (value: string) => Promise<void>;
  started: string[];
  release: (error?: unknown) => void;
  pending: () => number;
} {
  const started: string[] = [];
  const releases: Array<(error?: unknown) => void> = [];
  const perform = (value: string): Promise<void> => {
    started.push(value);
    const attempt = new Promise<void>((resolve, reject) => {
      releases.push((error?: unknown) => (error === undefined ? resolve() : reject(error)));
    });
    // The queue awaits this promise, so it is normally observed. A failed
    // attempt whose caller is superseded would otherwise be collected by the
    // runtime as an unhandled rejection from this helper rather than from the
    // code under test, so observe it here and keep the assertion honest.
    attempt.catch(() => undefined);
    return attempt;
  };
  return {
    perform,
    started,
    release: (error?: unknown) => {
      const next = releases.shift();
      if (next === undefined) throw new Error("no perform call is waiting to be released");
      next(error);
    },
    pending: () => releases.length,
  };
}

/** Let every already-scheduled microtask and promise continuation run. */
async function settleMicrotasks(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

describe("createSettledBurstQueue", () => {
  test("a synchronous A/B/C burst performs A first and then the latest value C", async () => {
    const controller = controllablePerform();
    const queue = createSettledBurstQueue(controller.perform);

    const first = queue.schedule("A");
    const second = queue.schedule("B");
    const third = queue.schedule("C");
    await settleMicrotasks();

    // A started immediately; B and C collapsed into one trailing slot.
    expect(controller.started).toEqual(["A"]);

    controller.release();
    await settleMicrotasks();
    expect(controller.started).toEqual(["A", "C"]);

    controller.release();
    await first;
    await third;
    // B never reached the server: it was superseded by C.
    expect(controller.started).toEqual(["A", "C"]);
    expect(controller.pending()).toBe(0);
    await second;
  });

  test("a superseded caller settles without waiting for unrelated later work", async () => {
    const controller = controllablePerform();
    const queue = createSettledBurstQueue(controller.perform);

    const order: string[] = [];
    const first = queue.schedule("A").then(() => { order.push("A"); });
    const superseded = queue.schedule("B").then(() => { order.push("B"); });
    const latest = queue.schedule("C").then(() => { order.push("C"); });

    await settleMicrotasks();
    // B is already superseded while A is still in flight, so it settles now.
    await superseded;
    expect(order).toEqual(["B"]);

    controller.release();
    await settleMicrotasks();
    controller.release();
    await Promise.all([first, latest]);

    expect(order).toEqual(["B", "A", "C"]);
    expect(controller.started).toEqual(["A", "C"]);
  });

  test("a failed write rejects its own caller but the drain continues", async () => {
    const controller = controllablePerform();
    const queue = createSettledBurstQueue(controller.perform);

    const failing = queue.schedule("A");
    const failingOutcome = failing.then(() => "resolved", (error: unknown) => error);
    const following = queue.schedule("B");
    await settleMicrotasks();

    controller.release(new Error("write rejected"));
    await settleMicrotasks();
    // The queue did not strand B behind the failure.
    expect(controller.started).toEqual(["A", "B"]);
    expect(await failingOutcome).toBeInstanceOf(Error);
    await expect(failing).rejects.toThrow("write rejected");

    controller.release();
    await following;
    expect(queue.isBusy()).toBe(false);
  });

  test("a fire-and-forget failure is contained and never an unhandled rejection", async () => {
    const controller = controllablePerform();
    const queue = createSettledBurstQueue(controller.perform);

    // A directly-ignored rejected promise is the exact shape the queue must
    // never produce, so the check below is proved to be able to fail before it
    // is trusted to pass.
    const ignored: Promise<void> = Promise.reject(new Error("control"));
    ignored.catch(() => undefined);
    void ignored;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      // Exactly how the autosave timer calls it: no await, no catch.
      void queue.schedule("A");
      await settleMicrotasks();
      controller.release(new Error("offline"));
      await settleMicrotasks(24);
      // A later edit still drains normally afterwards.
      const later = queue.schedule("B");
      await settleMicrotasks();
      controller.release();
      await later;
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(controller.started).toEqual(["A", "B"]);
  });

  test("the returned promise still rejects for a caller that awaits it", async () => {
    const controller = controllablePerform();
    const queue = createSettledBurstQueue(controller.perform);

    const awaited = queue.schedule("A");
    const outcome = awaited.then(() => null, (error: unknown) => error);
    await settleMicrotasks();
    controller.release(new Error("write failed"));

    expect(await outcome).toBeInstanceOf(Error);
    await expect(awaited).rejects.toThrow("write failed");
  });

  test("isBusy covers both the running burst and a waiting trailing value", async () => {
    const controller = controllablePerform();
    const queue = createSettledBurstQueue(controller.perform);

    expect(queue.isBusy()).toBe(false);
    const first = queue.schedule("A");
    await settleMicrotasks();
    expect(queue.isBusy()).toBe(true);
    const trailing = queue.schedule("B");
    expect(queue.isBusy()).toBe(true);

    controller.release();
    await settleMicrotasks();
    expect(queue.isBusy()).toBe(true);

    controller.release();
    await Promise.all([first, trailing]);
    expect(queue.isBusy()).toBe(false);
  });

  test("cancelPending drops the waiting value and settles its caller", async () => {
    const controller = controllablePerform();
    const queue = createSettledBurstQueue(controller.perform);

    const first = queue.schedule("A");
    await settleMicrotasks();
    const dropped = queue.schedule("B");
    queue.cancelPending();
    await dropped;

    controller.release();
    await first;
    // B was cancelled before it started, so it was never performed.
    expect(controller.started).toEqual(["A"]);
    expect(queue.isBusy()).toBe(false);
  });

  test("rejects a non-function perform", () => {
    // @ts-expect-error runtime guard for a JavaScript caller
    expect(() => createSettledBurstQueue(null)).toThrow(TypeError);
  });
});
