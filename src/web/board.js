// Board view (Task 13): one column per status, drag & drop plus keyboard
// moves, optimistic status updates with rollback, per-column quick add.
import * as api from "./api.js";
import { el, toast, errorBanner, navigate } from "./app.js";
import { registerView } from "./views.js";

const STATUSES = ["todo", "doing", "blocked", "done"];
const COLUMN_LABELS = { todo: "To do", doing: "Doing", blocked: "Blocked", done: "Done" };

function initials(name) {
  return name
    .split(/[\s_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function priorityClass(priority) {
  return ["p0", "p1", "p2", "p3"][priority] ?? "p2";
}

function cardNode(item, options) {
  const labels = (item.labels || []).map((label) => el("span", { class: "chip label-chip" }, label.name));
  const assignee = item.assignee
    ? el("span", { class: "avatar", title: item.assignee.name, style: `background:${item.assignee.kind === "agent" ? "#8B5CF6" : "#3B82F6"}` }, initials(item.assignee.name))
    : null;
  const card = el(
    "article",
    {
      class: `board-card`,
      tabindex: "0",
      draggable: "true",
      "data-id": String(item.id),
      "data-status": item.status,
      "aria-label": `#${item.id} ${item.title}, ${item.status}`,
      ondragstart: (event) => {
        event.dataTransfer.setData("text/plain", String(item.id));
        event.dataTransfer.effectAllowed = "move";
        card.classList.add("dragging");
      },
      ondragend: () => card.classList.remove("dragging"),
      onclick: () => navigate(`#/item/${item.id}`),
      onkeydown: (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          navigate(`#/item/${item.id}`);
          return;
        }
        const offsets = { ArrowLeft: -1, ArrowRight: 1 };
        if (event.key in offsets) {
          event.preventDefault();
          const index = STATUSES.indexOf(item.status);
          const next = STATUSES[Math.min(STATUSES.length - 1, Math.max(0, index + offsets[event.key]))];
          if (next !== item.status) options.onStatusChange(item, next);
        }
      },
    },
    el(
      "div",
      { class: "board-card-top" },
      el("span", { class: `chip ${priorityClass(item.priority)}` }, `P${item.priority}`),
      labels,
    ),
    el("div", { class: "board-card-title" }, item.title),
    el("div", { class: "board-card-bottom" }, el("span", { class: "muted" }, `#${item.id}`), assignee),
  );
  return card;
}

function quickAddForm(status, onCreated) {
  const input = el("input", { type: "text", placeholder: "Add item…", "aria-label": `Add item to ${COLUMN_LABELS[status]}` });
  const busy = { value: false };
  return el(
    "form",
    {
      class: "quick-add",
      onsubmit: async (event) => {
        event.preventDefault();
        const title = input.value.trim();
        if (!title || busy.value) return;
        busy.value = true;
        try {
          const created = await api.createItem({ title });
          if (status !== "todo") await api.updateItem(created.data.item.id, { status });
          input.value = "";
          onCreated();
        } catch (error) {
          toast(`Could not add item: ${error.message}`, true);
        } finally {
          busy.value = false;
        }
      },
    },
    input,
  );
}

async function mount(params, container) {
  const state = { items: [], participants: [] };

  const columns = new Map();
  const board = el(
    "div",
    { class: "board" },
    STATUSES.map((status) => {
      const cards = el("div", { class: "board-cards", "data-status": status });
      const column = el(
        "section",
        { class: "board-column", "data-status": status },
        el("h2", { class: "board-column-title" }, COLUMN_LABELS[status], el("span", { class: "count", "data-count": "" })),
        cards,
        quickAddForm(status, refresh),
      );
      columns.set(status, { column, cards });
      return column;
    }),
  );

  function renderCards() {
    for (const status of STATUSES) {
      const { cards, column } = columns.get(status);
      const items = state.items.filter((item) => item.status === status);
      cards.replaceChildren(
        ...items.map((item) => cardNode(item, { onStatusChange: changeStatus })),
      );
      column.querySelector("[data-count]").textContent = String(items.length);
    }
  }

  async function changeStatus(item, status, options = { optimistic: true }) {
    const previous = item.status;
    const apply = () => {
      item.status = status;
      if (status === "done") item.closedAt = item.closedAt ?? new Date().toISOString();
      if (status !== "done") item.closedAt = null;
      renderCards();
    };
    const revert = () => {
      item.status = previous;
      renderCards();
    };
    if (options.optimistic) apply();
    try {
      await api.updateItem(item.id, { status });
      if (options.optimistic) await refresh(); // reconcile with the server view
      return true;
    } catch (error) {
      if (options.optimistic) revert();
      toast(`Move failed: ${error.message}`, true);
      return false;
    }
  }

  async function refresh() {
    const result = await api.listItems({ limit: 100 });
    state.items = result.data;
    renderCards();
  }

  // Drag & drop wiring: columns are the drop targets.
  for (const status of STATUSES) {
    const { column, cards } = columns.get(status);
    column.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      column.classList.add("drop-target");
    });
    column.addEventListener("dragleave", () => column.classList.remove("drop-target"));
    column.addEventListener("drop", async (event) => {
      event.preventDefault();
      column.classList.remove("drop-target");
      const id = Number(event.dataTransfer.getData("text/plain"));
      const item = state.items.find((candidate) => candidate.id === id);
      if (!item || item.status === status) return;
      await changeStatus(item, status);
      void cards;
    });
  }

  container.replaceChildren(board);
  try {
    await refresh();
  } catch (error) {
    container.replaceChildren(errorBanner(error));
  }
}

registerView("board", { title: "Board", href: "#/board", mount });
