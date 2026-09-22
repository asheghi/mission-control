// Workboard API client (browser). Thin typed wrapper over the REST surface:
// bearer token from localStorage (survives server restarts, tabs, and browser
// restarts; sessionStorage is only read to migrate tokens from older builds),
// stable error envelope parsing.

const TOKEN_KEY = "workboard.token";

export class ApiError extends Error {
  constructor(code, message, status, details) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Development convenience: a `#token=...` URL fragment is consumed once, then
 * removed from the address bar.
 *
 * The fragment is used rather than a query string because a fragment is never
 * sent to the server, so it cannot reach an access log or a `Referer`. It is
 * still a credential in the URL, so it is moved into storage and erased from the
 * address bar immediately, before anything renders. `replaceState` (not
 * `pushState`) is deliberate: rewriting would otherwise leave the token in the
 * previous history entry, reachable with the Back button.
 *
 * A token already in storage wins: opening an old link must never silently
 * replace the credential you are working with.
 */
export function consumeTokenFromHash(hash = location.hash) {
  if (typeof hash !== "string" || !hash.startsWith("#token=")) return null;
  const payload = hash.slice("#token=".length);
  // The token ENDS at the next "#", which is the start of the route that follows
  // it (`#token=X#/list?q=a`). Slicing to the end of the string instead would
  // swallow the route into the token — storing a credential the server rejects
  // and losing the destination the link asked for.
  const separator = payload.indexOf("#");
  const token = separator === -1 ? payload : payload.slice(0, separator);
  if (token === "") return null;
  const route = separator === -1 ? "" : payload.slice(separator);
  const url = `${location.pathname}${location.search}${route}`;
  let accepted = false;
  try {
    history.replaceState(history.state ?? null, "", url);
    accepted = true;
  } catch {
    // A replaceState that fails still leaves the token in the URL, so it is not
    // adopted: better to show the sign-in form than to log in and leave the
    // credential sitting in the address bar.
    accepted = false;
  }
  if (!accepted) return null;
  setToken(token);
  return token;
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  }
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body = options.body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const response = await fetch(path, { ...options, headers, body });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // 204s and stream errors have no JSON body.
  }

  if (!response.ok) {
    const error = payload && payload.error ? payload.error : {};
    throw new ApiError(error.code ?? "HTTP_ERROR", error.message ?? response.statusText, response.status, error.details);
  }
  return payload ?? { data: null };
}

function withQuery(path, params) {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export const health = () => api("/api/health");
export const listItems = (params) => api(withQuery("/api/items", params));
export const listBacklog = () => api("/api/backlog");
export const getItem = (id) => api(`/api/items/${id}`);
export const createItem = (input) => api("/api/items", { method: "POST", body: input });
export const updateItem = (id, patch) => api(`/api/items/${id}`, { method: "PATCH", body: patch });
export const deleteItem = (id) => api(`/api/items/${id}`, { method: "DELETE" });
export const addRelationship = (id, input) => api(`/api/items/${id}/relationships`, { method: "POST", body: input });
export const removeRelationship = (id, relationshipId) => api(`/api/items/${id}/relationships/${relationshipId}`, { method: "DELETE" });
export const reorderItem = (id, input) => api(`/api/items/${id}/reorder`, { method: "POST", body: input });
export const addComment = (id, body) => api(`/api/items/${id}/comments`, { method: "POST", body: { body } });
export const myWork = (params) => api(withQuery("/api/me/work", params));
export const listParticipants = () => api("/api/participants");
export const listLabels = () => api("/api/labels");
export const createLabel = (input) => api("/api/labels", { method: "POST", body: input });

// Server-Sent Events via fetch-stream (EventSource cannot send the bearer
// header). Returns a controller-shaped object with .close().
//
// onClose fires exactly once whenever the stream stops, including when close()
// aborts it: without that, an aborted read rejects through the `aborted` guard
// below and the caller would never learn that its stream ended.
export function subscribeEvents(handlers, signal) {
  const controller = new AbortController();
  // An external signal that was ALREADY aborted never fires "abort" again, so
  // subscribing to it alone would start a stream the caller has already
  // cancelled. Check the initial state, then follow later aborts.
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", () => controller.abort());
  /** Exactly one terminal callback per subscription, whatever the exit path. */
  let finished = false;
  const finish = (error) => {
    if (finished) return;
    finished = true;
    // A deliberate close() still reports a normal end of stream; only an
    // unexpected failure is an error.
    if (error === undefined || controller.signal.aborted) handlers.onClose?.();
    else handlers.onError?.(error);
  };
  (async () => {
    try {
      // Aborted before we even started: report the close without a request.
      if (controller.signal.aborted) {
        finish();
        return;
      }
      const response = await fetch("/api/events", {
        headers: { Authorization: `Bearer ${getToken()}`, Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        finish();
        return;
      }
      if (!response.ok || !response.body) throw new ApiError("HTTP_ERROR", "event stream failed", response.status);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let pending = reader.read();
      pending.catch(() => {});
      while (true) {
        const result = await pending;
        if (result.done) break;
        pending = reader.read();
        pending.catch(() => {});
        buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = parseSseFrame(frame);
          if (event) {
            if (event.event.startsWith(":") || event.data === "") handlers.onComment?.(event.raw);
            else handlers.onEvent?.(event);
          }
        }
      }
      finish();
    } catch (error) {
      finish(error);
    }
  })();
  return { close: () => controller.abort() };
}

function parseSseFrame(frame) {
  const lines = frame.split("\n");
  let event = "message";
  let data = "";
  let raw = frame;
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (event === "message" && data === "") return { event: ": heartbeat", data: "", raw: frame };
  return { event, data, payload: data ? JSON.parse(data) : null, raw: frame };
}
