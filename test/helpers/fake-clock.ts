// Test helper: a deterministic timer clock for exercising backoff and debounce
// logic without real waiting. Implements the exact timer seam that
// createLiveRefreshController injects, so tests never touch global timers.
export interface FakeClock {
  readonly setTimeout: (fn: () => void, ms?: number) => number;
  // Accepts the opaque handle type the controller clears with.
  readonly clearTimeout: (handle: unknown) => void;
  /** Run every timer due at or before `now + ms`, in scheduled order. */
  advance(ms: number): void;
  /** Handles still scheduled (not run, not cleared). */
  pending(): number;
  /** Run one pending timer even if its delay has not elapsed. */
  fireNext(): boolean;
}

export function createFakeClock(): FakeClock {
  const timers = new Map<number, { readonly id: number; readonly fn: () => void; readonly at: number }>();
  let now = 0;
  let nextId = 1;

  return {
    setTimeout(fn, ms = 0) {
      const id = nextId++;
      timers.set(id, { id, fn, at: now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(Number(handle));
    },
    advance(ms) {
      const target = now + Math.max(0, Number(ms) || 0);
      for (;;) {
        const due = [...timers.values()].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id);
        const timer = due[0];
        if (timer === undefined) break;
        timers.delete(timer.id);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
    pending() {
      return timers.size;
    },
    fireNext() {
      const next = [...timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (next === undefined) return false;
      timers.delete(next.id);
      now = next.at;
      next.fn();
      return true;
    },
  };
}
