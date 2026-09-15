// Legacy DOM/navigation bridge shared by the imperative board, list, and
// detail views. The Preact shell owns all global lifecycle behavior.
import { publicErrorMessage } from "./public-errors.js";
//
// This module is deliberately inert. Importing it must never install
// listeners, render a shell, open an SSE stream, or pull in app.js. app.js
// continues to re-export these helpers only for compatibility; the browser
// entrypoint does not import that side-effectful legacy shell.

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
  return el("div", { class: "error-banner", role: "alert" }, publicErrorMessage(error));
}

// Setting location.hash fires the shell's hashchange listener, which performs
// the actual render; re-assigning the *same* hash fires nothing, so re-render
// through the hook installed by the active shell.
let rerender = () => {};

/** Shell hook: the active shell registers its refresh path for same-hash navigation. */
export function setNavigateRenderer(fn) {
  rerender = typeof fn === "function" ? fn : () => {};
}

export function navigate(hash) {
  if (location.hash === hash) rerender();
  else location.hash = hash;
}
