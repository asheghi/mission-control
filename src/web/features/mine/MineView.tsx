import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import * as api from "../../api.js";
import { isTerminalAuthError } from "../../public-errors.js";
import { safeErrorMessage } from "../../shell/safe-error";
import type { ViewComponentProps } from "../../shell/types";
import { minePageFromResponse, priorityLabel, statusLabel } from "./data";
import type { MineItem } from "./data";

const mineStatuses = new Set(["todo", "doing", "blocked", "done"]);

function statusFromHash(hash: string): string {
  const query = hash.split("?")[1];
  if (!query) return "";
  const value = new URLSearchParams(query).get("status") ?? "";
  return mineStatuses.has(value) ? value : "";
}

export function MineView({ refreshGeneration, onAuthenticationFailure }: ViewComponentProps) {
  const [status, setStatus] = useState(() => statusFromHash(location.hash));
  const [items, setItems] = useState<readonly MineItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const requestGeneration = useRef(0);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    const syncStatus = () => setStatus(statusFromHash(location.hash));
    window.addEventListener("hashchange", syncStatus);
    return () => window.removeEventListener("hashchange", syncStatus);
  }, []);

  const load = useCallback(async (next?: string | null, append = false) => {
    if (append && loadingMoreRef.current) return;
    const generation = ++requestGeneration.current;
    if (append) {
      loadingMoreRef.current = true;
      setLoadingMore(true);
    } else {
      loadingMoreRef.current = false;
      setLoadingMore(false);
      setLoading(true);
      setItems([]);
      setCursor(null);
    }
    setError("");
    try {
      const params: Record<string, string | number> = { limit: 25 };
      if (status) params.status = status;
      if (next) params.cursor = next;
      const page = minePageFromResponse(await api.myWork(params));
      if (generation !== requestGeneration.current) return;
      if (page === null) throw new Error("Unexpected response from the server.");
      setItems((current) => append ? [...current, ...page.items] : [...page.items]);
      setCursor(page.nextCursor);
    } catch (caught) {
      if (generation !== requestGeneration.current) return;
      if (isTerminalAuthError(caught)) onAuthenticationFailure();
      else setError(safeErrorMessage(caught));
    } finally {
      if (generation === requestGeneration.current) {
        setLoading(false);
        setLoadingMore(false);
        loadingMoreRef.current = false;
      }
    }
  }, [status, onAuthenticationFailure]);
  useEffect(() => {
    void load();
    return () => { requestGeneration.current += 1; loadingMoreRef.current = false; };
  }, [load, refreshGeneration]);

  const changeStatus = (value: string) => {
    const query = value ? `?status=${encodeURIComponent(value)}` : "";
    const hash = `#/mine${query}`;
    if (location.hash !== hash) location.hash = hash;
    setStatus(value);
  };
  return <section class="mine-view">
    <header class="page-header"><div><h1>My work</h1><p>Items assigned to you or mentioning you.</p></div></header>
    <label class="mine-filter">Status <select value={status} onChange={(event) => changeStatus((event.currentTarget as HTMLSelectElement).value)}><option value="">All statuses</option><option value="todo">To do</option><option value="doing">Doing</option><option value="blocked">Blocked</option><option value="done">Done</option></select></label>
    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{loadingMore ? "Loading more work…" : loading ? "Loading your work…" : ""}</p>
    {error ? <div class="error-banner" role="alert">Could not load your work: {error} <button type="button" onClick={() => void load()}>Retry</button></div> : null}
    {loading && !items.length ? <p>Loading your work…</p> : items.length === 0 ? <div class="mine-empty">{loading ? "Refreshing…" : "No work found for this filter."}</div> : <ul class="mine-list">{items.map(({ item, assigned, mentioned }) => <li key={item.id}>
      <div class="mine-title"><a href={`#/item/${item.id}`}>#{item.id} {item.title}</a><span class="mine-reasons">{assigned && <span class="mine-badge">Assigned</span>}{mentioned && <span class="mine-badge">Mentioned</span>}</span></div>
      <div class="mine-meta"><span class={`status status-${item.status}`}>{statusLabel(item.status)}</span><span>{priorityLabel(item.priority)}</span></div>
    </li>)}</ul>}
    <footer class="mine-footer">{items.length ? <span>{items.length} loaded</span> : null}{cursor && <button type="button" disabled={loadingMore} onClick={() => void load(cursor, true)}>{loadingMore ? "Loading…" : "Load more"}</button>}</footer>
  </section>;
}
