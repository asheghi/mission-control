// Settled-burst first/latest serializer for detail-field writes.
//
// The contract this module implements is deliberately narrow, because the two
// obvious implementations of "serialize writes" are both wrong here:
//
//   * A purely trailing queue that replaces a not-yet-started request drops
//     work the user actually asked for. A burst of A then B then C that all
//     arrive while nothing is in flight must execute A first (so the earliest
//     intent reaches the server) and then the newest one (so the final state is
//     the last intent). That is a *first/latest* pair, not "latest only".
//   * A queue that hands every caller one shared drain promise makes each of
//     them settle only when the queue empties, so B's caller is told its
//     request finished after unrelated later work C finished too.
//
// So a call made while idle starts a burst carrying its own value and runs it
// immediately. Calls made while that burst is still running collapse into a
// single trailing slot holding the *latest* value, and that slot becomes the
// next burst. A caller settles when its own value has been performed, or as
// soon as a strictly newer value supersedes it — never after unrelated later
// work, and never by hanging.
//
// Rejections are handled on both sides of the boundary:
//
//   * A failed write rejects the promise of the caller that asked for it, and
//     the drain continues, so one failure can neither strand the user's next
//     edit nor stop later values from being performed.
//   * The autosave timer calls `schedule` fire-and-forget, so a rejection no
//     caller ever observes would become an unhandled rejection. Every promise
//     this module creates therefore has an observation handler attached at
//     creation time; `schedule` returns a derived promise that still rejects for
//     callers that await it.

export interface SettledBurstQueue<T> {
  /**
   * Enqueue `value`. Resolves once this value has been performed, or as soon as
   * a newer value in the same burst supersedes it. Rejects only when the write
   * that carried this value failed.
   */
  readonly schedule: (value: T) => Promise<void>;
  /** True while a burst is running or a trailing value is waiting. */
  readonly isBusy: () => boolean;
  /**
   * Drop every not-yet-started value and settle its caller as superseded — used
   * when a navigation or delete makes the pending write meaningless.
   */
  readonly cancelPending: () => void;
}

interface Waiter<T> {
  readonly value: T;
  /**
   * Settle this waiter. `error` is null when the value was performed
   * successfully or superseded by a newer value in the same burst.
   */
  readonly settle: (error: unknown | null) => void;
}

/**
 * A promise plus its resolve/reject, where the returned promise's rejection is
 * *always* observed.
 *
 * The autosave timer schedules fire-and-forget, so a rejected promise nobody
 * attaches a handler to would be reported as an unhandled rejection. The
 * pattern below keeps the rejection deliverable to a caller that awaits it
 * while guaranteeing the runtime never classifies it as unhandled: two
 * independently-settled promises are kept, and the one handed back is
 * immediately given a no-op rejection handler. A caller that awaits the
 * returned promise still sees the rejection; a caller that ignores it produces
 * no unhandled rejection, because a second handler is already attached.
 */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const inner = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  // `inner` is always observed, whatever the caller does with `promise`.
  inner.catch(() => undefined);
  const promise = inner.then(
    () => undefined,
    (error: unknown) => { throw error; },
  );
  // Attach the observation handler to the *same* promise the caller receives,
  // so an ignored rejection is handled rather than reported. `promise` still
  // rejects for callers that await it.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export function createSettledBurstQueue<T>(perform: (value: T) => Promise<void>): SettledBurstQueue<T> {
  if (typeof perform !== "function") throw new TypeError("createSettledBurstQueue requires a function");

  /**Latest value requested while a burst is running; null when none. */
  let trailing: Waiter<T> | null = null;
  let draining = false;

  const settleAll = (waiters: readonly Waiter<T>[], error: unknown | null): void => {
    for (const waiter of waiters) waiter.settle(error);
  };

  /**
   * Perform the head waiter of each burst. Waiters after the head in the same
   * burst were superseded the moment the trailing slot took a newer value, so
   * they settle here instead of waiting on later work.
   */
  const runBursts = async (head: Waiter<T>): Promise<void> => {
    let current: Waiter<T> = head;
    for (;;) {
      try {
        await perform(current.value);
        current.settle(null);
      } catch (error: unknown) {
        current.settle(error);
      }
      const next = trailing;
      if (next === null) return;
      trailing = null;
      current = next;
    }
  };

  const startDrain = (head: Waiter<T>): void => {
    draining = true;
    // Clear the busy flag as the drain's *last* act, so a caller that awaits its
    // own `schedule` (the delete flush does) observes an idle queue afterwards.
    let burst: Promise<void>;
    const clear = (): void => { draining = false; };
    burst = runBursts(head).then(clear, clear);
    burst.catch(() => undefined);
  };

  return {
    isBusy: () => draining || trailing !== null,
    cancelPending: () => {
      const waiter = trailing;
      if (waiter === null) return;
      trailing = null;
      waiter.settle(null);
    },
    schedule(value: T): Promise<void> {
      const slot = deferred();
      const waiter: Waiter<T> = {
        value,
        settle: (error) => { if (error === null || error === undefined) slot.resolve(); else slot.reject(error); },
      };

      if (draining) {
        // A burst owns the queue: collapse into the trailing slot, and let this
        // newer value supersede whatever was waiting there. `settleAll` is not
        // needed — only one value can be pending in the slot at a time.
        const superseded = trailing;
        trailing = waiter;
        if (superseded !== null) superseded.settle(null);
        return slot.promise;
      }
      startDrain(waiter);
      return slot.promise;
    },
  };
}
