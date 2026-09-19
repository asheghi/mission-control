// Task 16/17 unit tests for the browser-side state helpers: SSE reconnect
// backoff, the "typing wins" refresh deferral (and its blur flush), tab
// keyboard math, hash-backed list filters, and board-card facts.
//
// The module is dependency-free and touches no browser global at import time,
// which is what makes it testable in Bun without a DOM library.
import { describe, expect, test } from "bun:test";
import * as uiStateModule from "../../../src/web/ui-state.js";
import { createFakeClock } from "../../helpers/fake-clock";
import type { FakeClock } from "../../helpers/fake-clock";

// --- Declared contract of the web asset --------------------------------------
// ui-state.js is a browser asset embedded verbatim as text ("/assets/ui-state.js"),
// so the server build sees it as a string. The test declares the surface it
// relies on and then verifies every member at runtime, which keeps this
// contract honest without shipping a parallel declaration file.

interface TypingTarget {
  readonly tagName: string;
}

interface ListFilters {
  status: string;
  assignee: string;
  label: string;
  q: string;
}

interface FilterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface FilterLocation {
  hash: string;
}

interface FilterHistory {
  readonly state?: unknown;
  replaceState(state: unknown, title: string, url: string): void;
}

type TimerHandle = unknown;

interface LiveRefreshOptions {
  refresh: () => void;
  isTyping?: (element: TypingTarget | null | undefined) => boolean;
  activeElement?: () => TypingTarget | null;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  viewEvent?: () => void;
  connect?: () => void;
  onStateChange?: (connected: boolean) => void;
  refreshDelayMs?: number;
  maxDelayMs?: number;
}

interface GuardedHandlers {
  onEvent?: (event?: { event: string }) => void;
  onClose?: () => void;
  onError?: (error: unknown) => void;
}

interface LiveRefreshController {
  start(): boolean;
  isStopped(): boolean;
  sessionId(): number;
  isCurrent(token: number): boolean;
  guard<T extends GuardedHandlers>(token: number, handlers: T): T;
  connected(): void;
  viewEvent(): boolean;
  handleBlur(): boolean;
  disconnected(): number | null;
  flushPending(): boolean;
  pendingRefresh(): boolean;
  attempts(): number;
  isConnected(): boolean;
  stop(): void;
}

interface DebounceOptions {
  fn: (...args: unknown[]) => void;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

interface Debounced {
  schedule(...args: unknown[]): void;
  cancel(): boolean;
  flush(...args: unknown[]): boolean;
  isPending(): boolean;
}

interface NavEntry {
  name?: string;
  title?: string;
  href?: string;
  hidden?: boolean;
}

interface NavState {
  current: number;
  active: boolean[];
}

interface LiveIndicatorState {
  label: string;
  subtitle: string;
  title: string;
  connection: string;
  description: string;
}

interface SerialQueue {
  isBusy(): boolean;
  schedule(...args: unknown[]): Promise<void>;
}

interface SerialQueueOptions {
  onError?: ((error: unknown, ...args: unknown[]) => void) | null;
}

interface FilterStore {
  load(): ListFilters;
  set(filters: Partial<ListFilters>): ListFilters;
  commit(filters: Partial<ListFilters>): ListFilters;
  reset(): ListFilters;
  hasHashQuery(): boolean;
}

interface CardMeta {
  commentCount: number;
  commentText: string;
  commentLabel: string;
  isAgent: boolean;
  agentLabel: string;
}

interface UiState {
  RECONNECT_BASE_MS: number;
  RECONNECT_MAX_MS: number;
  FILTER_KEYS: readonly string[];
  reconnectDelayMs(attempt: number, baseMs?: number, maxMs?: number): number;
  isActivelyTyping(element: TypingTarget | null | undefined): boolean;
  createLiveRefreshController(options: LiveRefreshOptions): LiveRefreshController;
  createDebounced(options: DebounceOptions): Debounced;
  createSerialQueue(invoke: (...args: unknown[]) => Promise<void> | void, options?: SerialQueueOptions): SerialQueue;
  resolveAssignableParticipant(assignee: { id?: number } | null | undefined, participants: { id?: number; name?: string }[]): string;
  navigationState(entries: NavEntry[], hash: unknown, ownerOf?: string): NavState;
  liveIndicatorState(connected: boolean): LiveIndicatorState;
  tabIndexForKey(key: string, currentIndex: number, tabCount: number): number | null;
  emptyFilters(): ListFilters;
  encodeListHash(filters: Partial<ListFilters> | null | undefined): string;
  parseListFilters(hash: unknown): ListFilters;
  hasActiveFilters(filters: Partial<ListFilters> | null | undefined): boolean;
  readStoredFilters(storage: FilterStorage | undefined): ListFilters;
  writeStoredFilters(storage: FilterStorage | undefined, filters: Partial<ListFilters>): boolean;
  createFilterStore(options?: {
    location?: FilterLocation | undefined;
    history?: FilterHistory | undefined;
    storage?: FilterStorage | undefined;
    onChange?: (filters: ListFilters) => void;
  }): FilterStore;
  cardMeta(
    item: { commentCount?: unknown; assignee?: { id?: number; name?: string; kind?: string } | null } | null | undefined,
  ): CardMeta;
  routeFromHash(hash: unknown): { name: string | null; id: number | null };
  resolveHashRoute(
    views: Record<string, { href?: string }> | null | undefined,
    hash: unknown,
  ): { name: string | null; view: { href?: string } | undefined; params: { id?: number } };
  canonicalHash(
    views: Record<string, { href?: string }> | null | undefined,
    hash: unknown,
  ): string;
}

// The asset is text to the bundler; here it is the real module Bun executes.
const ui = uiStateModule as unknown as UiState;
const {
  FILTER_KEYS,
  routeFromHash,
  resolveHashRoute,
  canonicalHash,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  cardMeta,
  createDebounced,
  createFilterStore,
  createLiveRefreshController,
  createSerialQueue,
  emptyFilters,
  encodeListHash,
  hasActiveFilters,
  isActivelyTyping,
  liveIndicatorState,
  navigationState,
  parseListFilters,
  readStoredFilters,
  reconnectDelayMs,
  resolveAssignableParticipant,
  tabIndexForKey,
  writeStoredFilters,
} = ui;

const input: TypingTarget = { tagName: "INPUT" };
const textarea: TypingTarget = { tagName: "TEXTAREA" };
const body: TypingTarget = { tagName: "BODY" };

// --- SSE reconnect backoff ---------------------------------------------------

describe("reconnectDelayMs", () => {
  test("grows exponentially from the base delay", () => {
    expect(reconnectDelayMs(1)).toBe(1000);
    expect(reconnectDelayMs(2)).toBe(2000);
    expect(reconnectDelayMs(3)).toBe(4000);
    expect(reconnectDelayMs(4)).toBe(8000);
    expect(reconnectDelayMs(5)).toBe(16000);
  });

  test("is capped so an outage never waits unbounded", () => {
    for (const attempt of [6, 12, 100, 1000]) {
      expect(reconnectDelayMs(attempt)).toBe(RECONNECT_MAX_MS);
    }
    expect(RECONNECT_MAX_MS).toBe(30000);
  });

  test("is monotonic and never exceeds the cap", () => {
    let previous = 0;
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      const delay = reconnectDelayMs(attempt);
      expect(delay).toBeGreaterThanOrEqual(previous);
      expect(delay).toBeLessThanOrEqual(RECONNECT_MAX_MS);
      previous = delay;
    }
  });

  test("degenerate attempts fall back to the base delay", () => {
    expect(reconnectDelayMs(0)).toBe(RECONNECT_BASE_MS);
    expect(reconnectDelayMs(-5)).toBe(RECONNECT_BASE_MS);
    expect(reconnectDelayMs(Number.NaN)).toBe(RECONNECT_BASE_MS);
  });
});

// --- typing detection --------------------------------------------------------

describe("isActivelyTyping", () => {
  test("true for text-entry controls, false otherwise", () => {
    expect(isActivelyTyping({ tagName: "INPUT" })).toBe(true);
    expect(isActivelyTyping({ tagName: "textarea" })).toBe(true);
    expect(isActivelyTyping({ tagName: "SELECT" })).toBe(true);
    expect(isActivelyTyping({ tagName: "BUTTON" })).toBe(false);
    expect(isActivelyTyping({ tagName: "BODY" })).toBe(false);
    expect(isActivelyTyping(null)).toBe(false);
    expect(isActivelyTyping(undefined)).toBe(false);
    expect(isActivelyTyping({ tagName: "" })).toBe(false);
  });
});

// --- live refresh controller -------------------------------------------------

/** The module must expose everything this suite relies on. */
describe("module surface", () => {
  test("exports the documented helpers", () => {
    for (const [name, value] of Object.entries({
      reconnectDelayMs,
      isActivelyTyping,
      createLiveRefreshController,
      createDebounced,
      createSerialQueue,
      resolveAssignableParticipant,
      navigationState,
      liveIndicatorState,
      tabIndexForKey,
      emptyFilters,
      encodeListHash,
      parseListFilters,
      hasActiveFilters,
      readStoredFilters,
      writeStoredFilters,
      createFilterStore,
      cardMeta,
      routeFromHash,
      resolveHashRoute,
      canonicalHash,
    })) {
      expect(typeof value, name).toBe("function");
    }
    expect(typeof RECONNECT_BASE_MS).toBe("number");
    expect(typeof RECONNECT_MAX_MS).toBe("number");
    expect(FILTER_KEYS).toEqual(["status", "assignee", "label", "q"]);
  });

  test("builds no DOM with innerHTML, and never uses eval", async () => {
    // Safe DOM construction is a hard requirement for every web asset.
    const asset = await Bun.file(new URL("../../../src/web/ui-state.js", import.meta.url)).text();
    for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
      expect(asset).not.toContain(forbidden);
    }
  });
});

function trackRefreshes(): { calls: { count: number }; refresh: () => void } {
  const calls = { count: 0 };
  return { calls, refresh: () => { calls.count += 1; } };
}

/** The controller's timer seam is exactly what the fake clock provides. */
function controllerOptions(clock: FakeClock): Pick<LiveRefreshOptions, "setTimer" | "clearTimer"> {
  return { setTimer: clock.setTimeout, clearTimer: clock.clearTimeout };
}

describe("createLiveRefreshController", () => {
  test("a refresh requested while typing is deferred, then performed after focus leaves", () => {
    const clock = createFakeClock();
    const { calls, refresh } = trackRefreshes();
    let focused: TypingTarget | null = input;
    const controller = createLiveRefreshController({
      refresh,
      activeElement: () => focused,
      ...controllerOptions(clock),
    });

    expect(controller.viewEvent()).toBe(true); // deferred
    clock.advance(10_000);
    expect(calls.count).toBe(0); // never fired while the cursor was in the field
    expect(controller.pendingRefresh()).toBe(true);

    focused = body; // focus left the input
    expect(controller.handleBlur()).toBe(true);
    expect(calls.count).toBe(1);
    expect(controller.pendingRefresh()).toBe(false);

    clock.advance(10_000);
    expect(calls.count).toBe(1); // exactly one refresh, no trailing duplicate
  });

  test("several events while typing still produce exactly one deferred refresh", () => {
    const clock = createFakeClock();
    const { calls, refresh } = trackRefreshes();
    let focused: TypingTarget | null = textarea;
    const controller = createLiveRefreshController({
      refresh,
      activeElement: () => focused,
      ...controllerOptions(clock),
    });

    controller.viewEvent();
    controller.viewEvent();
    controller.viewEvent();
    focused = body;
    controller.handleBlur();
    expect(calls.count).toBe(1);
    expect(controller.handleBlur()).toBe(false); // already flushed
    expect(calls.count).toBe(1);
  });

  test("blur while still inside a field keeps the refresh deferred", () => {
    const clock = createFakeClock();
    const { calls, refresh } = trackRefreshes();
    const controller = createLiveRefreshController({
      refresh,
      activeElement: () => input, // e.g. moving between two text fields
      ...controllerOptions(clock),
    });
    controller.viewEvent();
    expect(controller.handleBlur()).toBe(false);
    expect(calls.count).toBe(0);
    expect(controller.pendingRefresh()).toBe(true);
  });

  test("a deferred refresh is never dropped, even without a blur", () => {
    const clock = createFakeClock();
    const { calls, refresh } = trackRefreshes();
    const controller = createLiveRefreshController({
      refresh,
      activeElement: () => textarea,
      ...controllerOptions(clock),
    });
    controller.viewEvent();
    expect(controller.pendingRefresh()).toBe(true);
    expect(controller.flushPending()).toBe(true);
    expect(calls.count).toBe(1);
  });

  test("when not typing, events debounce into a single refresh", () => {
    const clock = createFakeClock();
    const { calls, refresh } = trackRefreshes();
    const controller = createLiveRefreshController({
      refresh,
      activeElement: () => body,
      ...controllerOptions(clock),
    });
    expect(controller.viewEvent()).toBe(false);
    expect(controller.viewEvent()).toBe(false);
    expect(calls.count).toBe(0);
    clock.advance(249);
    expect(calls.count).toBe(0);
    clock.advance(1);
    expect(calls.count).toBe(1); // one refresh for the burst
  });

  test("viewEvent() is reported to the host before deferral decisions", () => {
    const clock = createFakeClock();
    const { refresh } = trackRefreshes();
    const seen: string[] = [];
    const controller = createLiveRefreshController({
      refresh,
      viewEvent: () => seen.push("event"),
      activeElement: () => input,
      ...controllerOptions(clock),
    });
    controller.viewEvent();
    expect(seen).toEqual(["event"]);
  });

  test("blur with nothing pending performs no refresh", () => {
    const clock = createFakeClock();
    const { calls, refresh } = trackRefreshes();
    const controller = createLiveRefreshController({
      refresh,
      activeElement: () => body,
      ...controllerOptions(clock),
    });
    expect(controller.handleBlur()).toBe(false);
    expect(calls.count).toBe(0);
  });

  test("disconnects reconnect on the capped backoff schedule", () => {
    const clock = createFakeClock();
    const connects: number[] = [];
    const controller = createLiveRefreshController({
      refresh: () => {},
      connect: () => connects.push(1),
      ...controllerOptions(clock),
    });

    expect(controller.disconnected()).toBe(1000);
    clock.advance(999);
    expect(connects.length).toBe(0);
    clock.advance(1);
    expect(connects.length).toBe(1);

    expect(controller.disconnected()).toBe(2000);
    expect(controller.disconnected()).toBe(4000); // rescheduled to a later attempt
    clock.advance(4000);
    expect(connects.length).toBe(2);

    // A long outage saturates at the cap instead of growing without bound.
    for (let i = 0; i < 10; i += 1) controller.disconnected();
    const delay = controller.disconnected();
    expect(delay).toBe(RECONNECT_MAX_MS);
    clock.advance(RECONNECT_MAX_MS);
    expect(connects.length).toBe(3);
  });

  test("a reconnect resets backoff, and stop() cancels pending work", () => {
    const clock = createFakeClock();
    const connects: number[] = [];
    const states: boolean[] = [];
    const controller = createLiveRefreshController({
      refresh: () => {},
      connect: () => connects.push(1),
      onStateChange: (connected: boolean) => states.push(connected),
      ...controllerOptions(clock),
    });

    // Transitions only: the first disconnect is already "not connected".
    controller.disconnected();
    controller.disconnected();
    controller.disconnected();
    expect(controller.attempts()).toBe(3);

    controller.connected();
    expect(controller.attempts()).toBe(0);
    expect(controller.isConnected()).toBe(true);
    controller.connected(); // duplicate signal → no second transition
    expect(states).toEqual([true]);
    expect(controller.disconnected()).toBe(RECONNECT_BASE_MS); // back to base

    controller.stop();
    clock.advance(10 * RECONNECT_MAX_MS);
    expect(connects.length).toBe(0); // stop() must outlive every timer
    expect(clock.pending()).toBe(0);
    expect(states).toEqual([true, false]);
    expect(controller.disconnected()).toBeNull(); // signed out: no reschedule
    clock.advance(RECONNECT_MAX_MS);
    expect(connects.length).toBe(0);
  });

  // Regression: the page's very first render is the unauthenticated one, so the
  // controller was stopped before the user could ever sign in — and a stop()
  // that could not be undone left live updates dead for the rest of the page's
  // life, including after a later sign-out/sign-in cycle.
  test("a stopped controller can be re-armed for a later session", () => {
    const clock = createFakeClock();
    const connects: number[] = [];
    const states: boolean[] = [];
    const controller = createLiveRefreshController({
      refresh: () => {},
      connect: () => connects.push(1),
      onStateChange: (connected: boolean) => states.push(connected),
      ...controllerOptions(clock),
    });

    controller.stop();
    expect(controller.isStopped()).toBe(true);
    expect(controller.start()).toBe(true); // the sign-in path re-arms it
    expect(controller.isStopped()).toBe(false);
    expect(controller.isConnected()).toBe(false);

    // Reconnects and refreshes work again after the restart.
    expect(controller.disconnected()).toBe(RECONNECT_BASE_MS);
    clock.advance(RECONNECT_BASE_MS);
    expect(connects.length).toBe(1);

    controller.connected();
    expect(controller.isConnected()).toBe(true);
    expect(states).toEqual([true]);

    // start() on a running controller is a no-op, not a second session.
    const session = controller.sessionId();
    expect(controller.start()).toBe(false);
    expect(controller.sessionId()).toBe(session);
  });

  test("sign-in, sign-out, sign-in cycle keeps live updates working", () => {
    const clock = createFakeClock();
    const connects: number[] = [];
    const controller = createLiveRefreshController({
      refresh: () => {},
      connect: () => connects.push(1),
      ...controllerOptions(clock),
    });

    // 1. First page render with no token: stopped before any sign-in.
    controller.stop();
    // 2. Sign-in.
    controller.start();
    controller.connected();
    expect(controller.isConnected()).toBe(true);
    // 3. Sign-out, then 4. sign-in again.
    controller.stop();
    expect(controller.isConnected()).toBe(false);
    controller.start();
    controller.connected();
    expect(controller.isConnected()).toBe(true);
    // 5. An outage after the last sign-in still reconnects.
    expect(controller.disconnected()).toBe(RECONNECT_BASE_MS);
    clock.advance(RECONNECT_BASE_MS);
    expect(connects.length).toBe(1);
  });

  test("a stopped controller performs no refresh work", () => {
    const clock = createFakeClock();
    const { calls, refresh } = trackRefreshes();
    const controller = createLiveRefreshController({
      refresh,
      activeElement: () => body,
      ...controllerOptions(clock),
    });

    controller.viewEvent(); // debounce scheduled
    controller.stop();
    expect(controller.pendingRefresh()).toBe(false);
    clock.advance(10_000);
    expect(calls.count).toBe(0); // the in-flight timer must not fire
    expect(controller.viewEvent()).toBe(false);
    expect(controller.handleBlur()).toBe(false);
    expect(controller.flushPending()).toBe(false);
    clock.advance(10_000);
    expect(calls.count).toBe(0);
  });

  // Regression: a superseded stream's late callbacks could null the current
  // feed or mark a healthy stream disconnected.
  test("guard() drops callbacks from a superseded stream generation", () => {
    const controller = createLiveRefreshController({ refresh: () => {} });
    const seen: string[] = [];

    // Session 1 opens a stream and wraps its callbacks.
    const first = controller.sessionId();
    const firstHandlers: GuardedHandlers = controller.guard(first, {
      onClose: () => seen.push("close-1"),
      onEvent: () => seen.push("event-1"),
    });
    expect(controller.isCurrent(first)).toBe(true);

    // The session ends and a new one begins (sign-out → sign-in).
    controller.stop();
    controller.start();
    const second = controller.sessionId();
    expect(second).not.toBe(first);
    expect(controller.isCurrent(first)).toBe(false);

    const secondHandlers: GuardedHandlers = controller.guard(second, {
      onClose: () => seen.push("close-2"),
      onEvent: () => seen.push("event-2"),
    });

    // The OLD stream's callbacks arrive late and must do nothing at all.
    firstHandlers.onClose?.();
    firstHandlers.onEvent?.({ event: "item.updated" });
    expect(seen).toEqual([]);
    expect(controller.isConnected()).toBe(false); // never flipped by the ghost

    // The current stream's callbacks still work.
    secondHandlers.onEvent?.({ event: "item.updated" });
    expect(seen).toEqual(["event-2"]);
  });

  test("guard() ignores unknown handler names and non-functions", () => {
    const controller = createLiveRefreshController({ refresh: () => {} });
    const token = controller.sessionId();
    const guarded = controller.guard(token, {
      onClose: undefined,
      onError: "nope" as unknown as () => void,
    } as unknown as GuardedHandlers);
    expect(guarded.onClose).toBeUndefined();
    expect(guarded.onError).toBeUndefined();
    expect(() => controller.guard(token, {})).not.toThrow();
  });

  test("callbacks guarded against an unknown token never run", () => {
    const controller = createLiveRefreshController({ refresh: () => {} });
    const seen: string[] = [];
    const stale = controller.guard(999, { onClose: () => seen.push("close") });
    stale.onClose?.();
    expect(seen).toEqual([]);
  });
});

// --- guardable debounce ------------------------------------------------------

describe("createDebounced", () => {
  test("a burst of calls produces exactly one trailing invocation", () => {
    const clock = createFakeClock();
    const calls: unknown[][] = [];
    const debounced = createDebounced({
      fn: (...args: unknown[]) => calls.push(args),
      delayMs: 250,
      setTimer: clock.setTimeout,
      clearTimer: clock.clearTimeout,
    });

    debounced.schedule("a");
    clock.advance(100);
    debounced.schedule("b");
    clock.advance(100);
    debounced.schedule("c");
    expect(calls).toEqual([]);
    clock.advance(250);
    expect(calls).toEqual([["c"]]); // latest arguments win
  });

  // Regression: a keystroke typed just before a route change fired afterwards
  // and rewrote the *new* route's hash.
  test("cancel() drops the pending call so it can never fire later", () => {
    const clock = createFakeClock();
    const calls: unknown[][] = [];
    const debounced = createDebounced({
      fn: (...args: unknown[]) => calls.push(args),
      delayMs: 250,
      setTimer: clock.setTimeout,
      clearTimer: clock.clearTimeout,
    });

    debounced.schedule("stale");
    expect(debounced.isPending()).toBe(true);
    expect(debounced.cancel()).toBe(true);
    expect(debounced.isPending()).toBe(false);
    expect(debounced.cancel()).toBe(false); // idempotent
    clock.advance(10_000);
    expect(calls).toEqual([]); // unmounted view cannot rewrite another route
    expect(clock.pending()).toBe(0);
  });

  test("cancel() leaves the debounce usable afterwards", () => {
    const clock = createFakeClock();
    const calls: unknown[][] = [];
    const debounced = createDebounced({
      fn: (...args: unknown[]) => calls.push(args),
      delayMs: 100,
      setTimer: clock.setTimeout,
      clearTimer: clock.clearTimeout,
    });

    debounced.schedule("first");
    debounced.cancel();
    debounced.schedule("second");
    clock.advance(100);
    expect(calls).toEqual([["second"]]);
  });

  test("flush() runs a pending call immediately, once", () => {
    const clock = createFakeClock();
    const calls: unknown[][] = [];
    const debounced = createDebounced({
      fn: (...args: unknown[]) => calls.push(args),
      delayMs: 100,
      setTimer: clock.setTimeout,
      clearTimer: clock.clearTimeout,
    });

    debounced.schedule("now");
    expect(debounced.flush("now")).toBe(true);
    expect(calls).toEqual([["now"]]);
    expect(debounced.flush("again")).toBe(false); // nothing left to flush
    clock.advance(1000);
    expect(calls).toEqual([["now"]]);
  });

  test("requires a function", () => {
    expect(() => createDebounced({ fn: undefined as unknown as () => void })).toThrow();
  });
});

// --- primary navigation ------------------------------------------------------

describe("navigationState", () => {
  const nav: NavEntry[] = [
    { name: "board", title: "Board", href: "#/board" },
    { name: "list", title: "List", href: "#/list" },
  ];

  test("marks the matching view active", () => {
    expect(navigationState(nav, "#/board")).toEqual({ current: 0, active: [true, false] });
    expect(navigationState(nav, "#/list")).toEqual({ current: 1, active: [false, true] });
  });

  // Regression: "#/list?status=doing" was compared verbatim against "#/list",
  // so no nav item was marked active (and no aria-current was set) whenever the
  // list carried filters.
  test("a filtered list route still marks List active", () => {
    expect(navigationState(nav, "#/list?status=doing")).toEqual({ current: 1, active: [false, true] });
    expect(navigationState(nav, "#/list?status=doing&q=parse")).toEqual({ current: 1, active: [false, true] });
    expect(navigationState(nav, "#/list?assignee=7")).toEqual({ current: 1, active: [false, true] });
  });

  test("an item route highlights the section that owns it", () => {
    expect(navigationState(nav, "#/item/12")).toEqual({ current: 0, active: [true, false] });
    expect(navigationState(nav, "#/item/12?tab=edit")).toEqual({ current: 0, active: [true, false] });
    expect(navigationState(nav, "#/item/12", "list")).toEqual({ current: 1, active: [false, true] });
  });

  test("unknown and hostile routes highlight nothing", () => {
    for (const hash of ["#/nope", "#/constructor", "#/toString", "#/__proto__"]) {
      expect(navigationState(nav, hash), hash).toEqual({ current: -1, active: [false, false] });
    }
  });

  test("never marks more than one entry active", () => {
    const duplicates: NavEntry[] = [
      { name: "list", title: "List", href: "#/list" },
      { name: "list", title: "List again", href: "#/list" },
    ];
    const state = navigationState(duplicates, "#/list?q=x");
    expect(state.active.filter(Boolean)).toHaveLength(1);
    expect(state.active[0]).toBe(true);
  });

  test("falls back to the href path when an entry carries no name", () => {
    const unnamed: NavEntry[] = [{ href: "#/board" }, { href: "#/list" }];
    expect(navigationState(unnamed, "#/list?q=1")).toEqual({ current: 1, active: [false, true] });
  });

  test("tolerates degenerate input", () => {
    expect(navigationState([], "#/board")).toEqual({ current: -1, active: [] });
    expect(navigationState(null as unknown as NavEntry[], "#/board")).toEqual({ current: -1, active: [] });
    expect(navigationState([null as unknown as NavEntry], "#/board")).toEqual({ current: -1, active: [false] });
  });
});

// --- live indicator ----------------------------------------------------------

describe("liveIndicatorState", () => {
  // Regression: the state was communicated by colour alone (an "offline" class).
  test("states the connection in words, not by colour", () => {
    const online = liveIndicatorState(true);
    expect(online.connection).toBe("connected");
    expect(online.label).toBe("Live");
    expect(online.subtitle).toBe("");
    expect(online.description).toContain("connected");

    const offline = liveIndicatorState(false);
    expect(offline.connection).toBe("reconnecting");
    expect(offline.title).toContain("reconnecting");
    expect(offline.description.toLowerCase()).toContain("reconnecting");
  });

  test("distinguishes the two states by more than a class name", () => {
    const online = liveIndicatorState(true);
    const offline = liveIndicatorState(false);
    expect(offline.connection).not.toBe(online.connection);
    expect(offline.subtitle).not.toBe(online.subtitle);
    expect(offline.description).not.toBe(online.description);
    expect(offline.title).not.toBe(online.title);
  });

  test("every state carries non-empty accessible text", () => {
    for (const connected of [true, false]) {
      const state = liveIndicatorState(connected);
      for (const field of ["label", "title", "connection", "description"] as const) {
        expect(state[field].length, `${connected}:${field}`).toBeGreaterThan(0);
      }
    }
  });
});

// --- serialized whole-set mutations ------------------------------------------

describe("createSerialQueue", () => {
  /**
   * Records every operation and gates each one, so the test controls exactly
   * when a run finishes. `release()` completes the oldest in-flight operation.
   */
  function gated() {
    const started: unknown[][] = [];
    const completed: unknown[][] = [];
    const gates: (() => void)[] = [];
    const invoke = (...args: unknown[]) => {
      started.push(args);
      return new Promise<void>((resolve) => {
        gates.push(() => {
          completed.push(args);
          resolve();
        });
      });
    };
    return { invoke, started, completed, release: () => gates.shift()?.() };
  }

  /** Let the queue's internal awaits settle between gate releases. */
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  // Regression: two overlapping whole-set PATCHes raced, and the slower one
  // landed last and resurrected labels the user had just removed.
  test("edits made while a PATCH is in flight collapse into one trailing run", async () => {
    const op = gated();
    const queue = createSerialQueue(op.invoke);

    const first = queue.schedule("ab");
    await settle(); // the first run is now genuinely in flight
    expect(op.started).toEqual([["ab"]]);
    expect(queue.isBusy()).toBe(true);

    // Three more requests while that run is in flight: only the last survives.
    queue.schedule("a");
    queue.schedule("b");
    const last = queue.schedule("c");
    expect(op.started).toHaveLength(1); // nothing else started concurrently

    op.release(); // finish the first run
    await settle();
    // The follow-up run carries the LATEST set, not any intermediate one.
    expect(op.completed).toEqual([["ab"]]);
    expect(op.started[1]).toEqual(["c"]);

    op.release();
    await Promise.all([first, last]);
    expect(op.completed).toEqual([["ab"], ["c"]]);
    expect(queue.isBusy()).toBe(false);
  });

  test("never runs two operations concurrently", async () => {
    let concurrent = 0;
    let peak = 0;
    const started: number[] = [];
    const completed: number[] = [];
    const gates: (() => void)[] = [];
    const queue = createSerialQueue(async (value: unknown) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      started.push(value as number);
      await new Promise<void>((resolve) => gates.push(resolve));
      completed.push(value as number);
      concurrent -= 1;
    });

    const a = queue.schedule(1);
    await settle(); // first run in flight
    queue.schedule(2); // superseded by 3 before it can ever start
    const c = queue.schedule(3);
    expect(started).toEqual([1]);

    gates.shift()?.();
    await settle();
    expect(started).toEqual([1, 3]); // 2 was dropped, never sent

    gates.shift()?.();
    await Promise.all([a, c]);

    expect(completed).toEqual([1, 3]);
    expect(peak).toBe(1); // the whole point: no overlap
    expect(queue.isBusy()).toBe(false);
  });

  test("a sequential call runs immediately", async () => {
    const calls: unknown[][] = [];
    const queue = createSerialQueue((...args: unknown[]) => {
      calls.push(args);
    });

    await queue.schedule("one");
    expect(calls).toEqual([["one"]]);
    expect(queue.isBusy()).toBe(false);
    await queue.schedule("two");
    expect(calls).toEqual([["one"], ["two"]]);
  });

  test("a failing operation is contained and still drains the queued successor", async () => {
    const calls: unknown[][] = [];
    const failures: unknown[] = [];
    const queue = createSerialQueue(
      (...args: unknown[]) => {
        calls.push(args);
        if (args[0] === "boom") throw new Error("failed");
      },
      { onError: (error: unknown) => failures.push(error) },
    );

    // One rejected request must not strand the user's later edits, nor leak an
    // unhandled rejection into the console.
    await queue.schedule("boom");
    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).message).toBe("failed");
    expect(queue.isBusy()).toBe(false);

    await queue.schedule("after");
    expect(calls).toEqual([["boom"], ["after"]]);
    expect(failures).toHaveLength(1); // the successful call reported nothing
  });

  test("a failure with a queued successor still runs the successor", async () => {
    const calls: unknown[][] = [];
    const gates: (() => void)[] = [];
    const queue = createSerialQueue(
      (...args: unknown[]) => {
        calls.push(args);
        return new Promise<void>((_resolve, reject) => {
          gates.push(() => reject(new Error("network down")));
        });
      },
      { onError: () => {} },
    );

    const first = queue.schedule("first");
    await settle(); // first request is in flight
    const second = queue.schedule("second");
    gates.shift()?.(); // fail the in-flight request
    await settle();
    expect(calls).toEqual([["first"], ["second"]]); // successor still sent
    gates.shift()?.();
    await Promise.all([first, second]);
    expect(queue.isBusy()).toBe(false);
  });

  test("requires a function", () => {
    expect(() => createSerialQueue(undefined as unknown as () => void)).toThrow();
  });
});

// --- assignee selection ------------------------------------------------------

describe("resolveAssignableParticipant", () => {
  const roster = [
    { id: 1, name: "bahman" },
    { id: 7, name: "csr-agent" },
  ];

  // Regression: the control was set to the assignee id before its options
  // existed, so the select fell back to "Unassigned" while the item was assigned.
  test("returns the id only when the roster can represent it", () => {
    expect(resolveAssignableParticipant({ id: 7 }, roster)).toBe("7");
    expect(resolveAssignableParticipant({ id: 1 }, roster)).toBe("1");
  });

  test("returns empty (explicit Unassigned) when the participant is unknown", () => {
    expect(resolveAssignableParticipant({ id: 99 }, roster)).toBe("");
    expect(resolveAssignableParticipant({ id: 7 }, [])).toBe("");
    expect(resolveAssignableParticipant({ id: 7 }, undefined as unknown as { id: number }[])).toBe("");
  });

  test("an unassigned item is empty, never \"undefined\"", () => {
    expect(resolveAssignableParticipant(null, roster)).toBe("");
    expect(resolveAssignableParticipant(undefined, roster)).toBe("");
    expect(resolveAssignableParticipant({}, roster)).toBe("");
    expect(resolveAssignableParticipant({ id: null as unknown as number }, roster)).toBe("");
  });

  test("matches on numeric value, not on object identity or string form", () => {
    expect(resolveAssignableParticipant({ id: 7 }, [{ id: "7" as unknown as number }])).toBe("7");
    expect(resolveAssignableParticipant({ id: 7 }, [{ id: 8 }])).toBe("");
  });
});

// --- description tabs --------------------------------------------------------

describe("tabIndexForKey", () => {
  test("arrows wrap within the tablist", () => {
    expect(tabIndexForKey("ArrowRight", 0, 2)).toBe(1);
    expect(tabIndexForKey("ArrowRight", 1, 2)).toBe(0);
    expect(tabIndexForKey("ArrowLeft", 0, 2)).toBe(1);
    expect(tabIndexForKey("ArrowLeft", 1, 2)).toBe(0);
  });

  test("Home and End jump to the ends", () => {
    expect(tabIndexForKey("Home", 1, 2)).toBe(0);
    expect(tabIndexForKey("End", 0, 2)).toBe(1);
    expect(tabIndexForKey("Home", 1, 5)).toBe(0);
    expect(tabIndexForKey("End", 0, 5)).toBe(4);
  });

  test("unhandled keys return null so the host does not preventDefault", () => {
    expect(tabIndexForKey("Enter", 0, 2)).toBeNull();
    expect(tabIndexForKey("Tab", 0, 2)).toBeNull();
    expect(tabIndexForKey("ArrowUp", 0, 2)).toBeNull();
    expect(tabIndexForKey("a", 0, 2)).toBeNull();
  });

  test("degenerate tablists and indexes stay in range", () => {
    expect(tabIndexForKey("ArrowRight", 0, 0)).toBeNull();
    expect(tabIndexForKey("ArrowRight", -3, 2)).toBe(1);
    expect(tabIndexForKey("ArrowRight", 99, 2)).toBe(0);
    expect(tabIndexForKey("ArrowRight", Number.NaN, 2)).toBe(1);
  });
});

// --- list filters ------------------------------------------------------------

class FakeStorage implements FilterStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

interface FakeWindow {
  readonly location: FilterLocation;
  readonly history: FilterHistory;
  hash(): string;
  readonly pushed: string[];
  readonly replaced: string[];
}

function fakeWindow(initialHash = "#/list"): FakeWindow {
  let hash = initialHash;
  const pushed: string[] = [];
  const replaced: string[] = [];
  const location: FilterLocation = {
    get hash() {
      return hash;
    },
    set hash(value: string) {
      hash = value;
      pushed.push(value);
    },
  };
  const history: FilterHistory = {
    state: null,
    replaceState(_state: unknown, _title: string, url: string) {
      replaced.push(url);
      hash = url;
    },
  };
  return { location, history, hash: () => hash, pushed, replaced };
}

const filters = (partial: Partial<ListFilters>): ListFilters => ({ ...emptyFilters(), ...partial });

describe("list filter encoding", () => {
  test("a round trip preserves every filter", () => {
    const full = { status: "doing", assignee: "7", label: "backend", q: "parse retry" };
    const hash = encodeListHash(full);
    expect(hash).toBe("#/list?status=doing&assignee=7&label=backend&q=parse+retry");
    expect(parseListFilters(hash)).toEqual(full);
  });

  test("empty filters produce a clean hash", () => {
    expect(encodeListHash(emptyFilters())).toBe("#/list");
    expect(encodeListHash({})).toBe("#/list");
    expect(encodeListHash(null)).toBe("#/list");
    expect(hasActiveFilters(emptyFilters())).toBe(false);
    expect(hasActiveFilters(filters({ q: "x" }))).toBe(true);
    expect(hasActiveFilters(null)).toBe(false);
  });

  test("only non-empty filters are encoded", () => {
    expect(encodeListHash({ status: "", assignee: "unassigned", label: "", q: "" })).toBe("#/list?assignee=unassigned");
  });

  test("a hash without a query yields empty filters", () => {
    expect(parseListFilters("#/list")).toEqual(emptyFilters());
    expect(parseListFilters("#/board")).toEqual(emptyFilters());
    expect(parseListFilters("#/item/12")).toEqual(emptyFilters());
    expect(parseListFilters("")).toEqual(emptyFilters());
    expect(parseListFilters(undefined)).toEqual(emptyFilters());
    expect(parseListFilters(42)).toEqual(emptyFilters());
  });

  test("unknown keys are ignored and long queries are bounded", () => {
    expect(parseListFilters("#/list?status=done&bogus=1&constructor=2")).toEqual(filters({ status: "done" }));
    const long = parseListFilters(`#/list?q=${"a".repeat(500)}`);
    expect(FILTER_KEYS).toContain("q");
    expect(long.q.length).toBe(256);
  });

  test("a hostile hash cannot inject extra filter keys", () => {
    const parsed = parseListFilters("#/list?__proto__=x&status=todo");
    expect(Object.keys(parsed).sort()).toEqual(["assignee", "label", "q", "status"]);
    expect(parsed.status).toBe("todo");
  });

  test("stored filters survive a storage round trip", () => {
    const storage = new FakeStorage();
    expect(readStoredFilters(storage)).toEqual(emptyFilters());
    writeStoredFilters(storage, filters({ status: "blocked", q: "crash" }));
    expect(readStoredFilters(storage)).toEqual(filters({ status: "blocked", q: "crash" }));
  });

  test("malformed and hostile storage values fall back to empty filters", () => {
    const storage = new FakeStorage();
    storage.map.set("workboard.filters", "{not json");
    expect(readStoredFilters(storage)).toEqual(emptyFilters());
    storage.map.set("workboard.filters", "null");
    expect(readStoredFilters(storage)).toEqual(emptyFilters());
    storage.map.set("workboard.filters", JSON.stringify({ status: 42, q: null, label: "ok" }));
    expect(readStoredFilters(storage)).toEqual(filters({ label: "ok" }));
    expect(readStoredFilters(undefined)).toEqual(emptyFilters());

    const hostile: FilterStorage = {
      getItem() {
        throw new Error("storage disabled");
      },
      setItem() {
        throw new Error("storage disabled");
      },
    };
    expect(readStoredFilters(hostile)).toEqual(emptyFilters());
    expect(writeStoredFilters(hostile, emptyFilters())).toBe(false);
  });
});

describe("createFilterStore", () => {
  test("restores from the URL hash and persists it as the fallback", () => {
    const win = fakeWindow("#/list?status=doing&q=parse");
    const storage = new FakeStorage();
    const store = createFilterStore({ location: win.location, history: win.history, storage });
    expect(store.load()).toEqual(filters({ status: "doing", q: "parse" }));
    expect(readStoredFilters(storage)).toEqual(filters({ status: "doing", q: "parse" }));
  });

  test("falls back to storage when the hash carries no query", () => {
    const win = fakeWindow("#/list");
    const storage = new FakeStorage();
    writeStoredFilters(storage, filters({ status: "blocked" }));
    const store = createFilterStore({ location: win.location, history: win.history, storage });
    expect(store.load()).toEqual(filters({ status: "blocked" }));
  });

  test("set() rewrites the URL in place, leaving location.hash untouched (no hashchange)", () => {
    const win = fakeWindow("#/list");
    const store = createFilterStore({ location: win.location, history: win.history, storage: new FakeStorage() });
    store.set(filters({ status: "doing", q: "reconnect" }));
    // The URL is updated the way the browser address bar shows it...
    expect(win.replaced).toEqual(["#/list?status=doing&q=reconnect"]);
    // ...but location.hash is never assigned, so no hashchange fires and the
    // router does not remount the view out from under the user's cursor.
    expect(win.pushed).toEqual([]);
  });

  test("set() replaces the URL without adding history; commit() pushes one", () => {
    const win = fakeWindow("#/list");
    const storage = new FakeStorage();
    const store = createFilterStore({ location: win.location, history: win.history, storage });

    store.set(filters({ q: "typing" }));
    expect(win.hash()).toBe("#/list?q=typing");
    expect(win.pushed).toEqual([]); // no hashchange → no remount mid-typing
    expect(win.replaced).toEqual(["#/list?q=typing"]);
    expect(readStoredFilters(storage)).toEqual(filters({ q: "typing" }));

    store.commit(filters({ status: "doing" }));
    expect(win.pushed).toEqual(["#/list?status=doing"]); // deliberate change
    expect(readStoredFilters(storage)).toEqual(filters({ status: "doing" }));

    store.commit(filters({ status: "doing" })); // unchanged → no push
    expect(win.pushed).toEqual(["#/list?status=doing"]);
  });

  test("reset() clears the URL, storage, and filter state", () => {
    const win = fakeWindow("#/list?status=done&label=ops");
    const storage = new FakeStorage();
    const store = createFilterStore({ location: win.location, history: win.history, storage });
    store.load();
    expect(store.reset()).toEqual(emptyFilters());
    expect(win.hash()).toBe("#/list");
    expect(readStoredFilters(storage)).toEqual(emptyFilters());
    expect(store.hasHashQuery()).toBe(false);
  });

  test("a fully filtered URL reloads identically (reload restore)", () => {
    const storage = new FakeStorage();
    const first = fakeWindow("#/list");
    createFilterStore({ location: first.location, history: first.history, storage }).commit({
      status: "blocked",
      assignee: "unassigned",
      label: "urgent",
      q: "timeout",
    });
    // Simulate F5 at the committed URL: a new page, same hash, same storage.
    const reloaded = fakeWindow(first.hash());
    const store = createFilterStore({ location: reloaded.location, history: reloaded.history, storage });
    expect(store.load()).toEqual({ status: "blocked", assignee: "unassigned", label: "urgent", q: "timeout" });
  });

  test("onChange fires with the normalized filter set", () => {
    const win = fakeWindow("#/list");
    const seen: ListFilters[] = [];
    const store = createFilterStore({
      location: win.location,
      history: win.history,
      storage: new FakeStorage(),
      onChange: (next: ListFilters) => seen.push(next),
    });
    store.set({ ...filters({}), q: "  spaced  " });
    expect(seen).toEqual([filters({ q: "  spaced  " })]);
  });

  test("works without a location or history available", () => {
    const store = createFilterStore({ location: undefined, history: undefined, storage: new FakeStorage() });
    expect(store.load()).toEqual(emptyFilters());
    expect(store.set(filters({ q: "x" }))).toEqual(filters({ q: "x" }));
    expect(store.commit(emptyFilters())).toEqual(emptyFilters());
  });
});

// --- hash routing ------------------------------------------------------------

describe("routeFromHash", () => {
  test("a bare view hash resolves to that view", () => {
    expect(routeFromHash("#/board")).toEqual({ name: "board", id: null });
    expect(routeFromHash("#/list")).toEqual({ name: "list", id: null });
  });

  test("a query string belongs to view state, not to the view name", () => {
    // Regression: "#/list?status=doing" used to parse as a view named
    // "list?status=doing", which fell back to the board and made hash-backed
    // list filters unreachable.
    expect(routeFromHash("#/list?status=doing")).toEqual({ name: "list", id: null });
    expect(routeFromHash("#/list?status=doing&q=reconnect")).toEqual({ name: "list", id: null });
    expect(routeFromHash("#/board?x=1")).toEqual({ name: "board", id: null });
  });

  test("an item hash carries a positive integer id", () => {
    expect(routeFromHash("#/item/12")).toEqual({ name: "item", id: 12 });
    expect(routeFromHash("#/item/12?tab=edit")).toEqual({ name: "item", id: 12 });
    expect(routeFromHash("#/item/abc")).toEqual({ name: "item", id: null });
    expect(routeFromHash("#/item/0")).toEqual({ name: "item", id: null });
    expect(routeFromHash("#/item/-3")).toEqual({ name: "item", id: null });
  });

  test("an empty, missing, or hostile hash has no view name", () => {
    expect(routeFromHash("")).toEqual({ name: "backlog", id: null }); // default route
    expect(routeFromHash(undefined)).toEqual({ name: "backlog", id: null });
    expect(routeFromHash("#/")).toEqual({ name: null, id: null });
    expect(routeFromHash(42)).toEqual({ name: "backlog", id: null });
  });
});

describe("resolveHashRoute", () => {
  const views: Record<string, { href?: string }> = {
    board: { href: "#/board" },
    backlog: { href: "#/backlog" },
    list: { href: "#/list" },
    detail: { href: "#/item" },
  };

  test("selects the list view for a filtered hash", () => {
    const route = resolveHashRoute(views, "#/list?status=doing");
    expect(route.name).toBe("list");
    expect(route.view).toBe(views["list"]!);
    expect(route.params).toEqual({});
  });

  test("passes the item id through to the detail view", () => {
    expect(resolveHashRoute(views, "#/item/7")).toMatchObject({ name: "item", params: { id: 7 } });
    expect(resolveHashRoute(views, "#/item/7").view).toBe(views["detail"]!);
  });

  test("unknown views and prototype keys fall back to the backlog", () => {
    for (const hash of ["#/nope", "#/constructor", "#/toString", "#/__proto__", "#/"]) {
      const route = resolveHashRoute(views, hash);
      expect(route.view, hash).toBe(views["backlog"]!);
      expect(route.name, hash).toBe("backlog");

    }
  });

  test("an item id that is not a positive integer falls back to the backlog", () => {
    expect(resolveHashRoute(views, "#/item/abc").view).toBe(views["backlog"]!);
    expect(resolveHashRoute(views, "#/item/0").view).toBe(views["backlog"]!);
  });

  test("a registry in any order still resolves every route", () => {
    const reversed: Record<string, { href?: string }> = {};
    for (const [key, value] of Object.entries(views).reverse()) {
      if (value !== undefined) reversed[key] = value;
    }
    expect(resolveHashRoute(reversed, "#/list").name).toBe("list");
    expect(resolveHashRoute(reversed, "#/item/3").name).toBe("item");
  });
});

describe("canonicalHash", () => {
  const views: Record<string, { href?: string }> = {
    board: { href: "#/board" },
    backlog: { href: "#/backlog" },
    list: { href: "#/list" },
    detail: { href: "#/item" },
  };

  test("a recognised route is returned untouched, query included", () => {
    // The query is view state (list filters), never routing: canonicalising
    // must not strip it.
    expect(canonicalHash(views, "#/backlog")).toBe("#/backlog");
    expect(canonicalHash(views, "#/board")).toBe("#/board");
    expect(canonicalHash(views, "#/list?status=doing&q=tree")).toBe("#/list?status=doing&q=tree");
    expect(canonicalHash(views, "#/item/12")).toBe("#/item/12");
  });

  test("a bare URL, an unknown hash, and an unusable item id become the default view", () => {
    // These all *render* the fallback view, so the URL has to say so — otherwise
    // the address bar disagrees with the page and no nav entry is current.
    for (const hash of ["", "#/", "#/nope", "#/constructor", "#/__proto__", "#/item/abc", "#/item/0"]) {
      expect(canonicalHash(views, hash), hash).toBe("#/backlog");
    }
  });

  test("the canonical hash comes from the fallback view's own href", () => {
    // A registry without a backlog falls back to its first view, and the URL
    // follows that view rather than a hard-coded default.
    expect(canonicalHash({ board: { href: "#/board" } }, "#/nope")).toBe("#/board");
    expect(canonicalHash({ detail: { href: "#/item" }, board: { href: "#/board" } }, "")).toBe("#/item");
  });

  test("a hostile or empty registry still yields a usable hash", () => {
    expect(canonicalHash(null, "#/nope")).toBe("#/backlog");
    expect(canonicalHash({}, "#/nope")).toBe("#/backlog");
    expect(canonicalHash(views, 42)).toBe("#/backlog");
    expect(canonicalHash(views, undefined)).toBe("#/backlog");
    // A registration with no href cannot be navigated to, so the default wins.
    expect(canonicalHash({ backlog: {} }, "#/nope")).toBe("#/backlog");
  });
});

// --- board card facts --------------------------------------------------------

describe("cardMeta", () => {
  test("reports the comment count with a singular/plural label", () => {
    expect(cardMeta({ commentCount: 0 }).commentLabel).toBe("0 comments");
    expect(cardMeta({ commentCount: 1 }).commentLabel).toBe("1 comment");
    expect(cardMeta({ commentCount: 7 }).commentLabel).toBe("7 comments");
  });

  test("zero comments render nothing, counts render as digits", () => {
    expect(cardMeta({ commentCount: 0 }).commentText).toBe("");
    expect(cardMeta({ commentCount: 3 }).commentText).toBe("3");
  });

  test("a missing or invalid count is treated as zero, never NaN on the card", () => {
    expect(cardMeta({}).commentCount).toBe(0);
    expect(cardMeta({ commentCount: null }).commentCount).toBe(0);
    expect(cardMeta({ commentCount: Number.NaN }).commentCount).toBe(0);
    expect(cardMeta({ commentCount: "lots" }).commentCount).toBe(0);
    expect(cardMeta({ commentCount: -3 }).commentCount).toBe(0);
    expect(cardMeta({ commentCount: 2.9 }).commentCount).toBe(2);
    expect(cardMeta(undefined).commentCount).toBe(0);
  });

  test("marks agent assignees explicitly, and only agents", () => {
    expect(cardMeta({ assignee: { id: 1, name: "csr-agent", kind: "agent" } })).toMatchObject({
      isAgent: true,
      agentLabel: "Assigned to agent csr-agent",
    });
    expect(cardMeta({ assignee: { id: 2, name: "bahman", kind: "human" } })).toMatchObject({ isAgent: false, agentLabel: "" });
    expect(cardMeta({ assignee: null })).toMatchObject({ isAgent: false, agentLabel: "" });
    expect(cardMeta({}).isAgent).toBe(false);
    expect(cardMeta({ assignee: { kind: "agent" } })).toMatchObject({ isAgent: true, agentLabel: "Assigned to agent " });
  });
});
