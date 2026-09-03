// Workboard web shell (Task 12): hash router, login, navigation, shared DOM
// helpers. Views register themselves via views.js; live updates hook in via
// api.subscribeEvents.
import * as api from "./api.js";
import { views, registerView } from "./views.js";
import "./board.js";

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
    region = el("div", { class: "toast-region" });
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

function mountPlaceholder(name) {
  return () => el("div", { class: "placeholder card" }, `${name} view is not wired up yet.`);
}

registerView("list", { title: "List", href: "#/list", mount: mountPlaceholder("List") });
registerView("detail", { title: "Item", href: "#/item", hidden: true, mount: mountPlaceholder("Item detail") });

// --- Router ----------------------------------------------------------------

function currentRoute() {
  const hash = location.hash || "#/board";
  const segments = hash.replace(/^#\//, "").split("/");
  if (segments[0] === "item" && views.detail) {
    return { view: views.detail, params: { id: Number(segments[1]) } };
  }
  if (segments[0] && views[segments[0]]) return { view: views[segments[0]], params: {} };
  return { view: views.board ?? Object.values(views)[0], params: {} };
}

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

async function render() {
  if (!api.getToken()) {
    renderLogin();
    return;
  }
  const { view, params } = currentRoute();
  renderShell(view);
  const content = document.getElementById("content");
  content.replaceChildren();
  try {
    const mounted = await view.mount(params, content);
    if (mounted instanceof Node) content.replaceChildren(mounted);
  } catch (error) {
    if (error instanceof api.ApiError && error.status === 401) {
      api.setToken(null);
      renderLogin();
      return;
    }
    content.replaceChildren(errorBanner(error));
  }
}

function renderShell(view) {
  const current = location.hash || "#/board";
  const nav = el(
    "nav",
    {},
    Object.values(views)
      .filter((entry) => !entry.hidden)
      .map((entry) => {
        const active = current === entry.href || (entry.href === "#/board" && current.startsWith("#/item"));
        return el("a", { href: entry.href, class: active ? "active" : "" }, entry.title);
      }),
  );
  app.replaceChildren(
    el(
      "header",
      { class: "topbar" },
      el("span", { class: "brand" }, "Workboard"),
      nav,
      el(
        "span",
        { class: "who" },
        el("button", { onclick: signOut }, "Sign out"),
      ),
    ),
    el("main", { class: "content", id: "content" }),
  );
}

function signOut() {
  api.setToken(null);
  renderLogin();
}

function renderLogin() {
  const error = el("div", { class: "error" });
  const input = el("input", {
    type: "password",
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
          render();
        } catch (err) {
          api.setToken(null);
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
