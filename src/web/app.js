// Workboard web shell (Task 12): hash router, login, navigation, shared DOM
// helpers. Views register themselves via views.js; live updates hook in via
// api.subscribeEvents.
import * as api from "./api.js";
import { views, registerView } from "./views.js";
import { createLiveRefreshController, liveIndicatorState, navigationState, resolveHashRoute } from "./ui-state.js";
import "./board.js";
import "./list.js";
import "./detail.js";

const app = document.getElementById("app");

/** Tiny DOM builder: el("div", { class: "card", onclick }, children...). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "value") {
      node.value = value;
    } else if (key === "checked" || key === "selected" || key === "disabled") {
      node[key] = Boolean(value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function toast(message, isError = false) {
  let region = document.querySelector(".toast-region");
  if (!region) {
    region = el("div", { class: "toast-region", role: "status", "aria-live": "polite", "aria-atomic": "false" });
    document.body.append(region);
  }
  const item = el("div", { class: `toast${isError ? " error" : ""}` }, message);
  region.append(item);
  setTimeout(() => item.remove(), isError ? 6000 : 3200);
}

export function errorBanner(error) {
  return el("div", { class: "error-banner" }, error instanceof Error ? error.message : String(error));
}

// --- Views -----------------------------------------------------------------
// Views register themselves (board.js, list.js, detail.js).

// --- Live updates (Task 16) -------------------------------------------------
// One global SSE subscription per signed-in session: relevant events debounce
// into a re-render of the current view. A refresh requested while the user is
// typing is deferred rather than dropped — the blur listener below performs it
// as soon as focus leaves the field. A dropped stream reconnects with capped
// exponential backoff (1s, 2s, 4s … capped at 30s) and stops for good once the
// session is signed out, so an outage never becomes a reconnect loop.
//
// The controller is stopped — never destroyed — on sign-out and re-armed by
// beginLiveSession(), because the first render of a fresh page is the
// unauthenticated one: a stop() that could not be undone would leave live
// updates dead for the rest of the page's life after every sign-in.

let liveFeed = null;
let liveIndicator = null;

const liveRefresh = createLiveRefreshController({
  refresh: () => render(),
  connect: () => startLiveFeed(),
  onStateChange: () => refreshLiveIndicator(),
});

// Authentication failures are terminal: retrying a revoked token would loop
// forever, so the feed stops reconnecting until the next sign-in.
function stopReconnecting() {
  liveFeed = null;
  liveRefresh.stop();
}

/** Enter (or re-enter) the live session after a successful sign-in. */
function beginLiveSession() {
  liveRefresh.start(); // no-op when already running
  startLiveFeed();
}

function startLiveFeed() {
  if (liveFeed) return;
  if (!api.getToken()) return;
  // Every callback is bound to the generation that created the stream, so a
  // late onClose/onError from a stream we already replaced can neither null out
  // its successor nor mark the newer, healthy stream disconnected.
  const token = liveRefresh.sessionId();
  let handle = null;
  handle = api.subscribeEvents(
    liveRefresh.guard(token, {
      onEvent: (event) => {
        if (event.event.startsWith("item.") || event.event === "comment.created") liveRefresh.viewEvent();
      },
      onComment: () => liveRefresh.connected(),
      onClose: () => {
        // Only clear the slot when it still holds *this* stream; a superseded
        // stream closing late must not drop a newer, live feed on the floor.
        if (liveFeed === handle) liveFeed = null;
        liveRefresh.disconnected();
      },
      onError: (error) => {
        if (liveFeed === handle) liveFeed = null;
        if (error instanceof api.ApiError && (error.status === 401 || error.status === 403)) {
          api.setToken(null);
          stopReconnecting();
          renderLogin();
          return;
        }
        liveRefresh.disconnected();
      },
    }),
  );
  liveFeed = handle;
}

function stopLiveFeed() {
  const stream = liveFeed;
  // Clear the handle first: close() reports a normal end of stream, and that
  // callback must see an already-empty slot instead of nulling a newer feed.
  liveFeed = null;
  liveRefresh.stop();
  if (stream) stream.close();
}

// Focus can leave a deferred field without any other event; flush then.
document.addEventListener(
  "focusout",
  () => {
    liveRefresh.handleBlur();
  },
  true,
);

// --- Router ----------------------------------------------------------------

function currentRoute() {
  // Resolution lives in ui-state.js: the query (list filters) must not leak
  // into the path segments, and "#/list?status=doing" is the list view.
  return resolveHashRoute(views, location.hash);
}

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

// Each render owns a token; a render that has been superseded by a newer one
// (hash change during an await, sign-out, …) discards its result instead of
// painting stale content over the current view.
let renderToken = 0;
// The node the current view mounted, so it can be told it is being replaced.
let mountedView = null;

/**
 * Tell the mounted view it is going away, then drop our reference to it. A view
 * uses this to cancel pending debounced work (the list's search box), which
 * would otherwise fire after the route changed and rewrite the new route's URL.
 */
function unmountCurrentView() {
  const view = mountedView;
  mountedView = null;
  if (view !== null && typeof view.unmount === "function") {
    try {
      view.unmount();
    } catch {
      // A failing teardown must not block navigation.
    }
  }
}

async function render() {
  const token = ++renderToken;
  if (!api.getToken()) {
    stopLiveFeed();
    unmountCurrentView();
    renderLogin();
    return;
  }
  // Sign-in, reload with a stored token, and recovery all land here: make sure
  // the shared controller is armed before the feed starts.
  beginLiveSession();
  const { view, params } = currentRoute();
  renderShell();
  const content = document.getElementById("content");
  unmountCurrentView();
  content.replaceChildren();
  try {
    const mounted = await view.mount(params, content);
    if (token !== renderToken) {
      // A newer route already took over: tear this one down immediately rather
      // than leaving its timers running behind the current view.
      if (mounted && typeof mounted.unmount === "function") mounted.unmount();
      return;
    }
    const node = mounted instanceof Node ? mounted : content.firstChild;
    mountedView = node ?? null;
    if (node instanceof Node && node !== content.firstChild) content.replaceChildren(node);
  } catch (error) {
    if (token !== renderToken) return;
    if (error instanceof api.ApiError && error.status === 401) {
      api.setToken(null);
      renderLogin();
      return;
    }
    content.replaceChildren(errorBanner(error));
  }
}

/** Repaint the indicator from the controller's actual state, every shell render. */
function refreshLiveIndicator() {
  if (!liveIndicator) return;
  const state = liveIndicatorState(liveRefresh.isConnected());
  const label = el("span", { class: "live-label" }, state.label);
  const detail = el("span", { class: "live-detail" }, state.subtitle);
  liveIndicator.replaceChildren(label, detail);
  liveIndicator.title = state.title;
  liveIndicator.dataset.connection = state.connection;
  liveIndicator.classList.toggle("offline", state.connection !== "connected");
  liveIndicator.setAttribute("aria-label", state.description);
}

function renderShell() {
  // The registry key is the view *name*; tag each entry with it so
  // "#/list?status=doing" resolves to the List link (the query is view state)
  // and the hidden item route still highlights its owning board entry.
  const navEntries = Object.entries(views)
    .filter(([, entry]) => !entry.hidden)
    .map(([name, entry]) => ({ ...entry, name }));
  const navState = navigationState(navEntries, location.hash || "#/board");
  const nav = el(
    "nav",
    { "aria-label": "Primary navigation" },
    navEntries.map((entry, index) =>
      el(
        "a",
        {
          href: entry.href,
          class: navState.active[index] ? "active" : "",
          "aria-current": navState.active[index] ? "page" : null,
        },
        entry.title,
      ),
    ),
  );
  const mark = el(
    "span",
    { class: "brand-mark", "aria-hidden": "true" },
    el("span", {}),
    el("span", {}),
    el("span", {}),
  );
  // Live region, not decoration: the text says connected/reconnecting, so the
  // state never depends on colour alone.
  liveIndicator = el("span", {
    class: "live-indicator",
    role: "status",
    "aria-live": "polite",
  });
  refreshLiveIndicator();
  app.replaceChildren(
    el("a", { class: "skip-link", href: "#content" }, "Skip to content"),
    el(
      "header",
      { class: "topbar" },
      el("a", { class: "brand", href: "#/board", "aria-label": "Workboard home" }, mark, el("span", {}, "Workboard")),
      nav,
      el("div", { class: "topbar-actions" }, liveIndicator, el("button", { class: "button-invisible", onclick: signOut }, "Sign out")),
    ),
    el("main", { class: "content", id: "content" }),
  );
}

function signOut() {
  stopLiveFeed();
  unmountCurrentView();
  api.setToken(null);
  renderLogin();
}

function renderLogin() {
  liveIndicator = null;
  const error = el("div", { class: "error", role: "alert", "aria-live": "assertive" });
  const input = el("input", {
    type: "password",
    name: "api-token",
    "aria-label": "Workboard API token",
    placeholder: "Paste your API token (wb_…)",
    autocomplete: "off",
    autofocus: "autofocus",
  });
  const button = el("button", { class: "primary" }, "Sign in");
  const form = el(
    "form",
    {
      class: "card login",
      onsubmit: async (event) => {
        event.preventDefault();
        button.disabled = true;
        error.textContent = "";
        const token = input.value.trim();
        try {
          api.setToken(token);
          // Validate the credential with a cheap authenticated call.
          await api.listLabels();
          location.hash = "#/board";
          beginLiveSession(); // re-arm the shared controller for this session
          render();
        } catch (err) {
          api.setToken(null);
          stopLiveFeed();
          error.textContent = err instanceof api.ApiError && err.status === 401 ? "That token was not accepted." : `Sign-in failed: ${err.message}`;
        } finally {
          button.disabled = false;
        }
      },
    },
    el("h1", {}, "Workboard"),
    el("div", { class: "hint" }, "Ask an administrator to run: workboard token --for <participant>"),
    input,
    error,
    button,
  );
  app.replaceChildren(form);
  input.focus();
}

window.addEventListener("hashchange", render);
render();
