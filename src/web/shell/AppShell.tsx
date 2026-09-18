import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import * as api from "../api.js";
import { isTerminalAuthError } from "../public-errors.js";
import { views } from "../views";
import { createLiveRefreshController, liveIndicatorState, navigationState, resolveHashRoute } from "../ui-state.js";
import { ViewHost } from "./ViewHost";
import { safeErrorMessage } from "./safe-error";
import type { ComponentViewDefinition, EventStreamHandle, LiveController, ViewRoute } from "./types";

interface LoginProps {
  onSignedIn: (hash: string) => void;
}

function validCurrentHash(): string {
  const candidate = location.hash;
  if (candidate === "#/board" || /^#\/list(?:\?.*)?$/.test(candidate) || /^#\/item\/[1-9]\d*$/.test(candidate)) {
    return candidate;
  }
  return "#/board";
}

function Login({ onSignedIn }: LoginProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const requestGeneration = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
    return () => {
      requestGeneration.current += 1;
    };
  }, []);

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const generation = ++requestGeneration.current;
    setBusy(true);
    setError("");
    const token = inputRef.current?.value.trim() ?? "";
    try {
      api.setToken(token);
      await api.listLabels();
      if (generation !== requestGeneration.current) return;
      const destination = validCurrentHash();
      if (location.hash !== destination) location.hash = destination;
      onSignedIn(destination);
    } catch (caught: unknown) {
      if (generation !== requestGeneration.current) return;
      api.setToken(null);
      setError(isTerminalAuthError(caught) ? "That token was not accepted." : `Sign-in failed: ${safeErrorMessage(caught)}`);
    } finally {
      if (generation === requestGeneration.current) setBusy(false);
    }
  };

  return (
    <div class="auth-shell">
      <div class="auth-brand" aria-hidden="true">
        <span class="brand-mark"><span /><span /><span /></span>
        <span>MissionControl</span>
      </div>
      <form class="card login" onSubmit={submit}>
        <div class="login-heading">
          <p class="eyebrow">Operational workspace</p>
          <h1>Sign in to your workboard</h1>
          <p>Use the access token issued for your participant account.</p>
        </div>
        <label for="api-token">Access token</label>
        <input
          id="api-token"
          ref={inputRef}
          type="password"
          name="api-token"
          placeholder="Paste your token"
          autoComplete="off"
        />
        <div class="login-help">Need access? Ask an administrator to create a participant token.</div>
        <div class="error" role="alert" aria-live="assertive">{error}</div>
        <button class="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}

export function AppShell() {
  const [signedIn, setSignedIn] = useState(() => Boolean(api.getToken()));
  const [hash, setHash] = useState(() => location.hash || "#/board");
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [connected, setConnected] = useState(false);
  const feedRef = useRef<EventStreamHandle | null>(null);
  const startFeedRef = useRef<() => void>(() => undefined);
  const refreshViewRef = useRef<() => void>(() => undefined);

  refreshViewRef.current = () => setRefreshGeneration((value) => value + 1);

  const controllerRef = useRef<LiveController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createLiveRefreshController({
      refresh: () => refreshViewRef.current(),
      connect: () => startFeedRef.current(),
      onStateChange: () => setConnected(Boolean(controllerRef.current?.isConnected())),
    }) as LiveController;
  }
  const liveRefresh = controllerRef.current;

  const stopLiveFeed = useCallback(() => {
    const stream = feedRef.current;
    feedRef.current = null;
    liveRefresh.stop();
    stream?.close();
    setConnected(false);
  }, [liveRefresh]);

  const authenticationFailed = useCallback(() => {
    api.setToken(null);
    stopLiveFeed();
    setSignedIn(false);
  }, [stopLiveFeed]);

  startFeedRef.current = () => {
    if (feedRef.current !== null || !api.getToken()) return;
    const token = liveRefresh.sessionId();
    let handle: EventStreamHandle | null = null;
    handle = api.subscribeEvents(
      liveRefresh.guard(token, {
        onEvent: (event: { event: string }) => {
          if (event.event.startsWith("item.") || event.event === "comment.created") liveRefresh.viewEvent();
        },
        onComment: () => liveRefresh.connected(),
        onClose: () => {
          if (feedRef.current === handle) feedRef.current = null;
          liveRefresh.disconnected();
        },
        onError: (error: unknown) => {
          if (feedRef.current === handle) feedRef.current = null;
          if (error instanceof api.ApiError && (error.status === 401 || error.status === 403)) {
            authenticationFailed();
            return;
          }
          liveRefresh.disconnected();
        },
      }),
    ) as EventStreamHandle;
    feedRef.current = handle;
  };

  useEffect(() => {
    if (!signedIn) {
      stopLiveFeed();
      return;
    }
    liveRefresh.start();
    startFeedRef.current();
    return () => stopLiveFeed();
  }, [signedIn, liveRefresh, stopLiveFeed]);

  useEffect(() => {
    const routeChanged = () => {
      setHash(location.hash || "#/board");
    };
    const focusLeft = () => liveRefresh.handleBlur();
    window.addEventListener("hashchange", routeChanged);
    window.addEventListener("workboard:authentication-failed", authenticationFailed);
    document.addEventListener("focusout", focusLeft, true);
    return () => {
      window.removeEventListener("hashchange", routeChanged);
      window.removeEventListener("workboard:authentication-failed", authenticationFailed);
      document.removeEventListener("focusout", focusLeft, true);
    };
  }, [authenticationFailed, liveRefresh]);

  const route = useMemo(() => resolveHashRoute(views, hash) as ViewRoute, [hash]);
  const navEntries = useMemo(
    () => Object.entries(views as Record<string, ComponentViewDefinition>)
      .filter(([, entry]) => !entry.hidden)
      .map(([name, entry]) => ({ ...entry, name })),
    [],
  );
  const nav = navigationState(navEntries, hash);
  const live = liveIndicatorState(connected);

  if (!signedIn) {
    return (
      <main class="content">
        <Login onSignedIn={(destination) => {
          setHash(destination);
          setSignedIn(true);
        }} />
      </main>
    );
  }

  const skipToContent = (event: MouseEvent): void => {
    event.preventDefault();
    const content = document.getElementById("content");
    content?.focus();
    content?.scrollIntoView();
  };

  return (
    <>
      <a class="skip-link" href="#content" onClick={skipToContent}>Skip to content</a>
      <header class="topbar">
        <a class="brand" href="#/board" aria-label="MissionControl home">
          <span class="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span>MissionControl</span>
        </a>
        <nav aria-label="Primary navigation">
          {navEntries.map((entry, index) => (
            <a
              key={entry.name}
              href={entry.href}
              class={nav.active[index] ? "active" : ""}
              aria-current={nav.active[index] ? "page" : undefined}
            >
              {entry.title}
            </a>
          ))}
        </nav>
        <div class="topbar-actions">
          <span
            class={`live-indicator${live.connection === "connected" ? "" : " offline"}`}
            role="status"
            aria-live="polite"
            aria-label={live.description}
            title={live.title}
            data-connection={live.connection}
          >
            <span class="live-label">{live.label}</span>
            <span class="live-detail">{live.subtitle}</span>
          </span>
          <button class="button-invisible" onClick={authenticationFailed}>Sign out</button>
        </div>
      </header>
      <main class="content" id="content" tabIndex={-1}>
        <ViewHost
          key={hash}
          view={route.view}
          params={route.params}
          refreshGeneration={refreshGeneration}
          onAuthenticationFailure={authenticationFailed}
        />
      </main>
    </>
  );
}
