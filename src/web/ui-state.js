// Web shell state helpers (dependency-free, no DOM access at import time).
//
// Everything that would otherwise be untestable glue inside app.js / list.js
// lives here as a pure function or an explicitly injectable controller, so Bun
// can test the behaviour without a browser or a DOM library:
//   * capped exponential backoff for the SSE reconnect,
//   * the "typing wins" refresh deferral and its blur flush,
//   * roving-focus keyboard math for the ARIA tab pattern,
//   * URL/hash-backed list filters (encode, parse, restore, persist),
//   * small board-card presentation facts (comment count, agent marker).
//
// Timers, storage, focus, and the URL are all injected, so behaviour is driven
// deterministically by tests. No browser global is read at module scope.
//
// Two purity rules matter for correctness, not just for tests:
//   * refresh controllers are *created per signed-in session* and can be
//     re-armed after stop(), so the initial unauthenticated render cannot
//     permanently kill live updates;
//   * stream callbacks are guarded by an identity token, so a superseded
//     stream can never mark a newer one disconnected.

// --- SSE reconnect backoff ---------------------------------------------------

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30000;

/**
 * Delay before reconnect attempt `attempt` (1-based): exponential from the
 * base, clamped to the cap so an outage never produces unbounded waits or a
 * hot reconnect loop.
 */
export function reconnectDelayMs(attempt, baseMs = RECONNECT_BASE_MS, maxMs = RECONNECT_MAX_MS) {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const safeBase = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : RECONNECT_BASE_MS;
  const safeMax = Number.isFinite(maxMs) && maxMs >= safeBase ? maxMs : Math.max(safeBase, RECONNECT_MAX_MS);
  return Math.min(safeMax, safeBase * 2 ** (safeAttempt - 1));
}

// --- Refresh deferral ("never clobber what the user is typing") --------------

const TYPING_TAGS = ["INPUT", "TEXTAREA", "SELECT"];

/** True when the element is a field the user could be composing text in. */
export function isActivelyTyping(element) {
  if (element === null || element === undefined) return false;
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  return TYPING_TAGS.includes(tag);
}

/**
 * Refresh scheduler for live (SSE) updates.
 *
 * A refresh requested while the user is typing is *deferred*, never dropped:
 * the first blur after focus leaves a field performs it if nothing else already
 * did. A dropped stream reconnects with capped exponential backoff.
 *
 * Lifecycle: `stop()` makes the controller inert — no pending refresh, no
 * reconnect, no further state transitions — but it is NOT permanent. `start()`
 * re-arms the same controller for a later session, so signing in after an
 * unauthenticated first render (or after a sign-out) resumes live updates
 * instead of leaving them dead for the rest of the page's life.
 *
 * Identity: `sessionId()` returns the current subscription generation. Pass it
 * (or use `guard()`) when wiring stream callbacks so a late callback from a
 * stream that has already been replaced cannot disturb its successor.
 */
export function createLiveRefreshController({
  refresh,
  isTyping = isActivelyTyping,
  activeElement = defaultActiveElement,
  setTimer = defaultSetTimer,
  clearTimer = defaultClearTimer,
  viewEvent = () => {},
  connect = () => {},
  onStateChange = () => {},
  refreshDelayMs = 250,
  maxDelayMs = RECONNECT_MAX_MS,
}) {
  let attempt = 0;
  let refreshTimer = null;
  let reconnectTimer = null;
  let pendingRefresh = false;
  let connected = false;
  let stopped = false;
  // Bumped by every start()/stop(), so callbacks captured against an older
  // generation are recognisably stale.
  let session = 0;

  function clearRefreshTimer() {
    if (refreshTimer !== null) {
      clearTimer(refreshTimer);
      refreshTimer = null;
    }
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimer(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /** True when `token` still identifies the active subscription. */
  function isCurrent(token) {
    return !stopped && token === session;
  }

  /**
   * Wrap callbacks so anything arriving from a superseded generation is
   * dropped: a stale `onClose`/`onError` must not null out a newer stream or
   * flip the indicator offline while it is actually live.
   */
  function guard(token, handlers) {
    const wrapped = {};
    for (const [name, handler] of Object.entries(handlers ?? {})) {
      if (typeof handler !== "function") continue;
      wrapped[name] = (...args) => {
        if (!isCurrent(token)) return undefined;
        return handler(...args);
      };
    }
    return wrapped;
  }

  // State changes are announced once per transition, so a flapping feed does
  // not thrash the indicator with duplicate notifications.
  function setConnected(next) {
    if (stopped) return;
    if (connected === next) return;
    connected = next;
    onStateChange(next);
  }

  function flush() {
    if (!pendingRefresh) return false;
    pendingRefresh = false;
    clearRefreshTimer();
    refresh();
    return true;
  }

  return {
    start() {
      if (!stopped) return false;
      stopped = false;
      session += 1;
      attempt = 0;
      pendingRefresh = false;
      clearRefreshTimer();
      clearReconnectTimer();
      return true;
    },
    isStopped() {
      return stopped;
    },
    sessionId() {
      return session;
    },
    isCurrent(token) {
      return isCurrent(token);
    },
    guard(token, handlers) {
      return guard(token, handlers);
    },
    connected() {
      if (stopped) return;
      attempt = 0;
      clearReconnectTimer();
      setConnected(true);
    },
    viewEvent() {
      if (stopped) return false;
      viewEvent();
      if (isTyping(activeElement())) {
        pendingRefresh = true; // completed on blur, never silently dropped
        return true;
      }
      clearRefreshTimer();
      refreshTimer = setTimer(() => {
        refreshTimer = null;
        if (stopped) return;
        refresh();
      }, refreshDelayMs);
      return false;
    },
    handleBlur() {
      if (stopped) return false;
      if (isTyping(activeElement())) return false;
      return flush();
    },
    disconnected() {
      if (stopped) return null;
      setConnected(false);
      attempt += 1;
      const delay = reconnectDelayMs(attempt, RECONNECT_BASE_MS, maxDelayMs);
      clearReconnectTimer();
      reconnectTimer = setTimer(() => {
        reconnectTimer = null;
        if (!stopped) connect();
      }, delay);
      return delay;
    },
    flushPending() {
      if (stopped) return false;
      return flush();
    },
    pendingRefresh() {
      return pendingRefresh;
    },
    attempts() {
      return attempt;
    },
    isConnected() {
      return connected;
    },
    stop() {
      stopped = true;
      session += 1; // invalidate every outstanding callback token
      pendingRefresh = false;
      clearRefreshTimer();
      clearReconnectTimer();
      connected = false;
    },
  };
}

// Browser defaults, resolved lazily inside function bodies (never at module
// scope) so importing this module outside a page cannot throw.
function defaultActiveElement() {
  try {
    const active = typeof document !== "undefined" ? document.activeElement : null;
    return active !== null && typeof active.tagName === "string" ? active : null;
  } catch {
    return null;
  }
}

function defaultSetTimer(fn, ms) {
  return setTimeout(fn, ms);
}

function defaultClearTimer(handle) {
  clearTimeout(handle);
}

// --- Hash routing -----------------------------------------------------------

/**
 * Collapse a hash into `{ name, id }`, ignoring any query string: the query
 * carries view state (list filters), so "#/list?status=doing" is the list view
 * and not a view named "list?status=doing". Unknown or hostile hashes (e.g.
 * "constructor") resolve to no name at all.
 */
export function routeFromHash(hash) {
  const raw = typeof hash === "string" && hash !== "" ? hash : "#/backlog";
  const path = raw.replace(/^#\//, "").split("?")[0];
  const segments = path.split("/");
  const name = segments[0] ?? "";
  if (name === "") return { name: null, id: null };
  if (name === "item") {
    const id = Number(segments[1]);
    return { name: "item", id: Number.isInteger(id) && id > 0 ? id : null };
  }
  return { name, id: null };
}

/**
 * The view to mount for `hash`: a prototype key from `views` is never treated
 * as a view name, and an unknown view falls back to the backlog (or the first
 * registered view).
 */
export function resolveHashRoute(views, hash) {
  const { name, id } = routeFromHash(hash);
  if (name === "item" && id !== null && views && views.detail) {
    return { name: "item", view: views.detail, params: { id } };
  }
  // Object.hasOwn: "constructor" / "toString" must not resolve as view names.
  if (name !== null && views && Object.hasOwn(views, name)) {
    return { name, view: views[name], params: {} };
  }
  const fallbackName = views && Object.hasOwn(views, "backlog") ? "backlog" : Object.keys(views ?? {})[0] ?? null;
  return { name: fallbackName, view: views?.[fallbackName] ?? undefined, params: {} };
}

/**
 * The hash the address bar should be showing for `hash`.
 *
 * A bare URL, or a hash that names no registered view, still *renders* the
 * fallback view — but the URL would then disagree with the page, and no
 * navigation entry would be marked current, because the nav compares entries
 * against the unresolved name ("#/nope" matches nothing). This returns the
 * canonical hash for exactly those cases, so the default view is what the URL
 * says it is. A recognised route is returned untouched, query string included:
 * the query carries view state (list filters), never routing.
 */
export function canonicalHash(views, hash) {
  const raw = typeof hash === "string" ? hash : "";
  const route = resolveHashRoute(views, raw);
  const { name } = routeFromHash(raw);
  if (raw !== "" && name !== null && name === route.name) return raw;
  const href = route.view?.href;
  return typeof href === "string" && href !== "" ? href : "#/backlog";
}

// --- Primary navigation -----------------------------------------------------

/**
 * Per-navigation state for `nav` links: which one is the current page and, for
 * every entry, whether it should render as active / `aria-current="page"`.
 *
 * A filtered list route (`#/list?status=doing`) must keep List marked active —
 * comparing a raw href against the raw hash compares "#/list" to
 * "#/list?status=doing" and silently highlights nothing at all. Routes are
 * resolved by view *name* (the query is view state, never part of the name),
 * with the href path as the fallback for registrations without a matching name.
 *
 * Pass the *visible* nav entries. An item route (`#/item/12`) has no nav entry
 * of its own — the detail view is registered hidden — so it highlights the
 * entry that owns it (`ownerOf`, default the board): the user is still "in"
 * that section, and the original shell behaved the same way.
 *
 * Exactly one entry wins when several match, so a stray duplicate registration
 * cannot paint two `aria-current="page"` links.
 */
export function navigationState(entries, hash, ownerOf = "board") {
  const list = Array.isArray(entries) ? entries : [];
  const target = routeFromHash(hash);
  const owners = list.map((entry) => {
    if (entry === null || typeof entry !== "object") return false;
    const href = typeof entry.href === "string" ? entry.href : "";
    if (target.name === null) return false;
    // A hidden child route belongs to its owning section.
    if (target.name === "item") return entry.name === ownerOf || routeFromHash(href).name === ownerOf;
    if (entry.name === target.name) return true;
    return routeFromHash(href).name === target.name;
  });
  const current = owners.indexOf(true);
  return {
    current,
    active: owners.map((owned, index) => owned && index === (current === -1 ? index : current)),
  };
}

/** Compare two hashes on their path only, ignoring "#" and any query string. */
export function sameHashPath(a, b) {
  const left = typeof a === "string" ? a : "";
  const right = typeof b === "string" ? b : "";
  const strip = (value) => value.replace(/^#/, "").split("?")[0];
  return right !== "" && strip(left) === strip(right);
}

// --- Assignee selection -----------------------------------------------------

/**
 * The `<select>` value that actually represents `item`'s assignee.
 *
 * A select silently falls back to its first option when told a value it has no
 * option for — so after participants load (or fail to load), the control can sit
 * on "Unassigned" and lie about an item that *is* assigned. This returns the
 * matching option value, or "" when the roster does not contain that
 * participant, which the host applies explicitly instead of by accident.
 */
export function resolveAssignableParticipant(assignee, participants) {
  const id = assignee?.id;
  if (id === null || id === undefined) return "";
  const desired = String(id);
  const roster = Array.isArray(participants) ? participants : [];
  const known = roster.some((participant) => participant !== null && participant !== undefined && String(participant.id) === desired);
  return known ? desired : "";
}

// --- Serialized async mutations ---------------------------------------------

/**
 * Trailing-only serializer for an async operation: calls made while one is in
 * flight collapse into a single follow-up run carrying the *latest* arguments.
 *
 * Whole-set mutations (PATCH /api/items/:id replaces the entire label set) race
 * when they overlap: the slower request lands last and silently resurrects the
 * labels the user just removed. Routing every one of them through a queue makes
 * the final server state equal the last requested set.
 *
 * `isBusy()` covers both the in-flight run and a queued successor, which is
 * what a host uses to disable its controls.
 */
export function createSerialQueue(invoke, { onError = null } = {}) {
  if (typeof invoke !== "function") throw new TypeError("createSerialQueue requires a function");
  // Work waiting to run. `next` is the immediate successor: while an operation
  // is in flight, a newer request *replaces* it, so a burst of whole-set edits
  // collapses into one trailing run of the latest set instead of replaying
  // every intermediate set against the server.
  let queued = null;
  let running = false;
  let drain = null;

  return {
    isBusy() {
      return running || queued !== null;
    },
    /**
     * Queue `args`; while a run is in flight, the newest call supersedes any
     * not-yet-started one.
     *
     * Resolves once the queue has drained *through* this request, so a caller
     * that awaits its own call never hangs on an unrelated successor.
     *
     * A failed operation is contained: it is routed to `onError` (when given)
     * and the queue keeps draining, because one rejected request must neither
     * strand the user's later edits nor surface as an unhandled rejection.
     */
    schedule(...args) {
      queued = args;
      if (drain !== null) return drain; // the in-flight run will pick this up
      drain = Promise.resolve().then(async () => {
        running = true;
        try {
          while (queued !== null) {
            const current = queued;
            queued = null;
            try {
              await invoke(...current);
            } catch (error) {
              if (onError !== null) onError(error, ...current);
            }
          }
        } finally {
          running = false;
          drain = null;
        }
      });
      return drain;
    },
  };
}

// --- Live (SSE) indicator ---------------------------------------------------

/**
 * The indicator's presentation facts. A status is never colour alone: the
 * element carries visible text ("Live" / "Offline · reconnecting") plus an
 * accessible description, so a screen reader (or a greyscale display) is told
 * the same thing the colour is.
 *
 * The label itself has to change, not just the subtitle: narrow layouts hide
 * the subtitle, which left the dot's colour as the only difference between a
 * connected and a dropped feed on a phone.
 */
export function liveIndicatorState(connected) {
  return connected
    ? {
        label: "Live",
        subtitle: "",
        title: "Live updates connected",
        connection: "connected",
        description: "Live updates connected",
      }
    : {
        label: "Offline",
        subtitle: "reconnecting",
        title: "Live updates disconnected — reconnecting",
        connection: "reconnecting",
        description: "Live updates disconnected, reconnecting",
      };
}

// --- Description tabs: roving focus (WAI-ARIA tabs pattern) ------------------

/**
 * Next tab index for a horizontal tablist: arrows wrap, Home/End jump.
 * Returns null for keys the pattern does not handle (so the host can ignore
 * them without preventDefault).
 */
export function tabIndexForKey(key, currentIndex, tabCount) {
  if (!Number.isInteger(tabCount) || tabCount <= 0) return null;
  const index = Number.isInteger(currentIndex) ? Math.min(Math.max(currentIndex, 0), tabCount - 1) : 0;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % tabCount;
    case "ArrowLeft":
      return (index - 1 + tabCount) % tabCount;
    case "Home":
      return 0;
    case "End":
      return tabCount - 1;
    default:
      return null;
  }
}

// --- List filters: URL/hash-backed and restorable ---------------------------

export const FILTER_KEYS = ["status", "assignee", "label", "q"];

const FILTERS_STORAGE_KEY = "workboard.filters";
const HASH_PREFIX = "#/list";
// Keep the shareable URL short; the search box itself is not length-limited.
const MAX_QUERY_LENGTH = 256;

/** The empty filter set (also the reset target). */
export function emptyFilters() {
  return { status: "", assignee: "", label: "", q: "" };
}

/** `#/list?status=doing&q=parse` for the non-empty filters. */
export function encodeListHash(filters) {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters?.[key];
    if (typeof value !== "string") continue;
    const trimmed = key === "q" ? value : value.trim();
    if (trimmed === "") continue;
    params.set(key, trimmed);
  }
  const query = params.toString();
  return query === "" ? HASH_PREFIX : `${HASH_PREFIX}?${query}`;
}

/** Any `#…?key=value` hash (list filters, not the item route) → filter set. */
export function parseListFilters(hash) {
  const filters = emptyFilters();
  if (typeof hash !== "string") return filters;
  const separator = hash.indexOf("?");
  if (separator === -1) return filters;
  let params;
  try {
    params = new URLSearchParams(hash.slice(separator + 1));
  } catch {
    return filters;
  }
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value !== null) filters[key] = value.slice(0, MAX_QUERY_LENGTH);
  }
  return filters;
}

/** True when at least one filter narrows the list. */
export function hasActiveFilters(filters) {
  return FILTER_KEYS.some((key) => typeof filters?.[key] === "string" && filters[key] !== "");
}

export function readStoredFilters(storage) {
  if (!storage) return emptyFilters();
  let raw;
  try {
    raw = storage.getItem(FILTERS_STORAGE_KEY);
  } catch {
    return emptyFilters(); // private mode / disabled storage
  }
  if (typeof raw !== "string" || raw === "") return emptyFilters();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyFilters();
  }
  return filtersFromRecord(parsed);
}

export function writeStoredFilters(storage, filters) {
  if (!storage) return false;
  try {
    storage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filtersFromRecord(filters)));
    return true;
  } catch {
    return false;
  }
}

function filtersFromRecord(record) {
  const filters = emptyFilters();
  if (record === null || typeof record !== "object") return filters;
  const source = record;
  for (const key of FILTER_KEYS) {
    const value = source[key];
    if (typeof value === "string") filters[key] = value.slice(0, MAX_QUERY_LENGTH);
  }
  return filters;
}

/**
 * Bind the list view's filter state to the URL hash (canonical, shareable,
 * restored on reload) with local storage as a fallback for a bare `#/list`.
 * A clean URL follows an explicit reset; otherwise the stored filters come
 * back so a reload never silently widens the list the user was looking at.
 */
export function createFilterStore({
  location = defaultLocation(),
  history = defaultHistory(),
  storage = defaultStorage(),
  onChange = () => {},
} = {}) {
  const currentHash = () => (typeof location?.hash === "string" ? location.hash : "");

  function persist(filters) {
    writeStoredFilters(storage, filters);
  }

  function replace(filters) {
    persist(filters);
    if (!location || !history) return;
    const target = encodeListHash(filters);
    if (currentHash() === target) return;
    // history.replaceState rewrites the URL without adding a history entry and
    // without firing hashchange — unlike `location.hash =` and unlike
    // `location.replace()`, which both do. In-flight typing therefore keeps its
    // focus: the router never remounts the view mid-keystroke.
    history.replaceState(history.state ?? null, "", target);
  }

  function store() {
    return {
      load() {
        const hash = currentHash();
        const withQuery = hash.includes("?");
        const fromHash = parseListFilters(hash);
        if (withQuery) {
          persist(fromHash); // the URL wins and becomes the new fallback
          return fromHash;
        }
        const stored = readStoredFilters(storage);
        return hasActiveFilters(stored) ? stored : fromHash;
      },
      set(filters) {
        const next = filtersFromRecord(filters);
        replace(next);
        onChange(next);
        return next;
      },
      commit(filters) {
        const next = filtersFromRecord(filters);
        persist(next);
        if (location) {
          const target = encodeListHash(next);
          if (currentHash() !== target) location.hash = target;
        }
        onChange(next);
        return next;
      },
      reset() {
        return store().set(emptyFilters());
      },
      hasHashQuery() {
        return currentHash().includes("?");
      },
    };
  }

  return store();
}

function defaultLocation() {
  try {
    return typeof window !== "undefined" ? window.location : undefined;
  } catch {
    return undefined;
  }
}function defaultHistory() {
  try {
    return typeof window !== "undefined" ? window.history : undefined;
  } catch {
    return undefined;
  }
}

function defaultStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch {
    return undefined; // storage can throw on access in hardened browsers
  }
}

// --- Guardable debounce ------------------------------------------------------

/**
 * Debounce `fn`, with two guarantees a bare setTimeout wrapper does not give:
 *
 *   * `cancel()` drops the pending call, so a view that unmounted (or a route
 *     that changed) can never rewrite the URL or re-render *another* view from
 *     a keystroke the user typed in a view that no longer exists;
 *   * `isPending()` lets the host tell "nothing scheduled" from "scheduled".
 *
 * Timers are injected for the same reason as everywhere else in this module.
 */
export function createDebounced({ fn, delayMs = 250, setTimer = defaultSetTimer, clearTimer = defaultClearTimer }) {
  if (typeof fn !== "function") throw new TypeError("createDebounced requires a function");
  let timer = null;

  return {
    schedule(...args) {
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        fn(...args);
      }, delayMs);
    },
    cancel() {
      if (timer === null) return false;
      clearTimer(timer);
      timer = null;
      return true;
    },
    flush(...args) {
      if (timer === null) return false;
      clearTimer(timer);
      timer = null;
      fn(...args);
      return true;
    },
    isPending() {
      return timer !== null;
    },
  };
}

// --- Board card facts -------------------------------------------------------

/**
 * Presentation facts for a board card: how many comments it has (with the
 * accessible label) and whether the assignee is an agent. Counts are data —
 * a card with no comments must not claim one, and a malformed count must not
 * render as NaN.
 */
export function cardMeta(item) {
  const rawCount = item?.commentCount;
  const count = typeof rawCount === "number" && Number.isFinite(rawCount) ? Math.max(0, Math.trunc(rawCount)) : 0;
  const assignee = item?.assignee ?? null;
  const isAgent = assignee !== null && assignee.kind === "agent";
  const title = typeof assignee?.name === "string" ? assignee.name : "";
  return {
    commentCount: count,
    commentText: count === 0 ? "" : String(count),
    commentLabel: count === 1 ? "1 comment" : `${count} comments`,
    isAgent,
    agentLabel: isAgent ? `Assigned to agent ${title}` : "",
  };
}
