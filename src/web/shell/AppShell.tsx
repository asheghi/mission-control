import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import * as api from "../api.js";
import { isTerminalAuthError } from "../public-errors.js";
import { views } from "../views";
import { createLiveRefreshController, canonicalHash, liveIndicatorState, navigationState, resolveHashRoute } from "../ui-state.js";
import { ViewHost } from "./ViewHost";
import { safeErrorMessage } from "./safe-error";
import { applyThemePreference, readThemePreference, resolvedTheme as getResolvedTheme, saveThemePreference, systemTheme, THEME_STORAGE_KEY, type ResolvedTheme, type ThemePreference } from "../theme";
import type { ComponentViewDefinition, EventStreamHandle, LiveController, ViewRoute } from "./types";

interface ThemeControlProps {
  theme: ResolvedTheme;
  onToggle: () => void;
}

interface LoginProps extends ThemeControlProps {
  onSignedIn: (hash: string) => void;
}

function ThemeControl({ theme, onToggle }: ThemeControlProps) {
  const nextTheme = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${nextTheme} theme`;
  return (
    <button
      type="button"
      class="theme-toggle"
      aria-label={label}
      aria-pressed={theme === "dark"}
      title={label}
      onClick={onToggle}
    >
      {theme === "dark" ? (
        <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
        </svg>
      ) : (
        <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M20.6 15.2A8.5 8.5 0 0 1 8.8 3.4 8.5 8.5 0 1 0 20.6 15.2Z" />
        </svg>
      )}
    </button>
  );
}

function validCurrentHash(): string {
  const candidate = location.hash;
  if (candidate === "#/board" || candidate === "#/backlog" || /^#\/list(?:\?.*)?$/.test(candidate) || /^#\/item\/[1-9]\d*$/.test(candidate)) {
    return candidate;
  }
  return "#/backlog";
}

function Login({ onSignedIn, theme, onToggle }: LoginProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
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
      // The failure is the first thing a keyboard user lands on, so the next
      // Tab press moves to the field that needs the corrected token.
      errorRef.current?.focus();
    } finally {
      if (generation === requestGeneration.current) setBusy(false);
    }
  };

  return (
    <div class="auth-shell">
      <div class="auth-header">
        <div class="auth-brand" aria-hidden="true">
          <span class="brand-mark"><span /><span /><span /></span>
          <span>MissionControl</span>
        </div>
        <ThemeControl theme={theme} onToggle={onToggle} />
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
          placeholder="Paste your token…"
          autoComplete="off"
          spellcheck={false}
        />
        <div class="login-help">Need access? Ask an administrator to create a participant token.</div>
        <div ref={errorRef} class="error" role="alert" aria-live="assertive" tabIndex={-1}>{error}</div>
        <button class="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}

export function AppShell() {
  const [signedIn, setSignedIn] = useState(() => Boolean(api.getToken()));
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readThemePreference());
  const [activeTheme, setActiveTheme] = useState<ResolvedTheme>(() => getResolvedTheme(themePreference));
  const [hash, setHash] = useState(() => location.hash || "#/backlog");
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [connected, setConnected] = useState(false);
  const feedRef = useRef<EventStreamHandle | null>(null);
  const startFeedRef = useRef<() => void>(() => undefined);
  const refreshViewRef = useRef<() => void>(() => undefined);

  const toggleTheme = useCallback(() => {
    const preference: ThemePreference = activeTheme === "dark" ? "light" : "dark";
    saveThemePreference(preference);
    setThemePreference(preference);
    setActiveTheme(preference);
  }, [activeTheme]);

  useEffect(() => {
    applyThemePreference(themePreference);
    setActiveTheme(getResolvedTheme(themePreference));
  }, [themePreference]);

  useEffect(() => {
    if (themePreference !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const synchronizeSystemTheme = () => setActiveTheme(systemTheme());
    synchronizeSystemTheme();
    media.addEventListener("change", synchronizeSystemTheme);
    return () => media.removeEventListener("change", synchronizeSystemTheme);
  }, [themePreference]);

  useEffect(() => {
    const synchronizeTheme = (event: StorageEvent) => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
      const preference = readThemePreference();
      applyThemePreference(preference);
      setThemePreference(preference);
      setActiveTheme(getResolvedTheme(preference));
    };
    window.addEventListener("storage", synchronizeTheme);
    return () => window.removeEventListener("storage", synchronizeTheme);
  }, []);

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
      setHash(location.hash || "#/backlog");
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

  // The URL must name the view that is actually rendered. A bare URL or an
  // unrecognised hash still falls back to the default view, but leaving the
  // address bar untouched made the page and the URL disagree — and left no
  // navigation entry marked current. `replaceState` keeps this out of the
  // history stack: the user did not navigate anywhere.
  useEffect(() => {
    if (!signedIn) return;
    const canonical = canonicalHash(views, location.hash);
    if (canonical === location.hash) return;
    history.replaceState(history.state ?? null, "", canonical);
    setHash(canonical);
  }, [signedIn, hash]);
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
        <Login
          theme={activeTheme}
          onToggle={toggleTheme}
          onSignedIn={(destination) => {
            setHash(destination);
            setSignedIn(true);
          }}
        />
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
        <a class="brand" href="#/backlog" aria-label="MissionControl home">
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
          <ThemeControl theme={activeTheme} onToggle={toggleTheme} />
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
