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
export const getItem = (id) => api(`/api/items/${id}`);
export const createItem = (input) => api("/api/items", { method: "POST", body: input });
export const updateItem = (id, patch) => api(`/api/items/${id}`, { method: "PATCH", body: patch });
export const deleteItem = (id) => api(`/api/items/${id}`, { method: "DELETE" });
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
