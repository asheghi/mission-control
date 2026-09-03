// List view (Task 14): filterable, cursor-paginated table with bulk assign.
import * as api from "./api.js";
import { el, toast, navigate } from "./app.js";
import { registerView } from "./views.js";

const STATUSES = ["todo", "doing", "blocked", "done"];
const PAGE_SIZE = 25;

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

async function mount(params, container) {
  const state = {
    items: [],
    nextCursor: null,
    participants: [],
    labels: [],
    selected: new Set(),
    filters: { status: "", assignee: "", label: "", q: "" },
  };

  const tableBody = el("tbody");
  const selectionBar = el("div", { class: "selection-bar", hidden: "hidden" });
  const statusSelect = el(
    "select",
    { "aria-label": "Filter by status" },
    el("option", { value: "" }, "All statuses"),
    STATUSES.map((status) => el("option", { value: status }, status)),
  );
  const assigneeSelect = el(
    "select",
    { "aria-label": "Filter by assignee" },
    el("option", { value: "" }, "Any assignee"),
    el("option", { value: "unassigned" }, "Unassigned"),
  );
  const labelSelect = el(
    "select",
    { "aria-label": "Filter by label" },
    el("option", { value: "" }, "Any label"),
  );
  const searchInput = el("input", { type: "search", placeholder: "Search titles…", "aria-label": "Search titles" });
  const loadMoreButton = el("button", { onclick: () => loadMore() }, "Load more");
  const pageInfo = el("span", { class: "muted" });

  function updateSelectionBar() {
    const count = state.selected.size;
    if (count === 0) {
      selectionBar.setAttribute("hidden", "hidden");
      return;
    }
    selectionBar.removeAttribute("hidden");
    selectionBar.replaceChildren(
      el("span", {}, `${count} selected`),
      (() => {
        const assignPicker = el("select", { "aria-label": "Assign selected to" }, el("option", { value: "" }, "Assign to…"));
        for (const participant of state.participants) {
          assignPicker.append(el("option", { value: String(participant.id) }, participant.name));
        }
        assignPicker.addEventListener("change", () => {
          const participantId = Number(assignPicker.value);
          if (participantId > 0) bulkAssign(participantId);
        });
        return assignPicker;
      })(),
      el("button", { onclick: () => bulkAssign(null) }, "Unassign"),
      el("button", { onclick: () => clearSelection() }, "Clear"),
    );
  }

  function clearSelection() {
    state.selected.clear();
    updateSelectionBar();
    for (const box of tableBody.querySelectorAll('input[type="checkbox"]')) box.checked = false;
  }

  async function bulkAssign(participantId) {
    const ids = [...state.selected];
    const results = await Promise.allSettled(ids.map((id) => api.updateItem(id, { assigneeId: participantId })));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) toast(`${failed} of ${ids.length} updates failed`, true);
    else toast(`Updated ${ids.length} item(s)`);
    clearSelection();
    await refresh({ reset: true });
  }

  function rowFor(item) {
    const checkbox = el("input", {
      type: "checkbox",
      "aria-label": `Select #${item.id}`,
      checked: state.selected.has(item.id),
      onclick: (event) => {
        event.stopPropagation();
        if (checkbox.checked) state.selected.add(item.id);
        else state.selected.delete(item.id);
        updateSelectionBar();
      },
    });
    return el(
      "tr",
      {
        tabindex: "0",
        "data-id": String(item.id),
        onclick: () => navigate(`#/item/${item.id}`),
        onkeydown: (event) => {
          if (event.key === "Enter") navigate(`#/item/${item.id}`);
        },
      },
      el("td", { class: "cell-check" }, checkbox),
      el("td", { class: "muted" }, `#${item.id}`),
      el("td", {}, item.title),
      el("td", {}, el("span", { class: "chip" }, item.status)),
      el("td", {}, `P${item.priority}`),
      el("td", {}, item.assignee ? item.assignee.name : "—"),
      el("td", {}, (item.labels || []).map((label) => el("span", { class: "chip label-chip", style: "margin-right:4px" }, label.name))),
    );
  }

  function renderRows() {
    tableBody.replaceChildren(...state.items.map(rowFor));
    const more = state.nextCursor !== null;
    loadMoreButton.toggleAttribute("hidden", !more);
    pageInfo.textContent = `${state.items.length} item(s)`;
    updateSelectionBar();
  }

  async function fetchPage({ reset }) {
    const params = { limit: PAGE_SIZE };
    if (!reset && state.nextCursor) params.cursor = state.nextCursor;
    if (state.filters.status) params.status = state.filters.status;
    if (state.filters.assignee) params.assignee = state.filters.assignee;
    if (state.filters.label) params.label = state.filters.label;
    if (state.filters.q) params.q = state.filters.q;
    const result = await api.listItems(params);
    state.items = reset ? result.data : [...state.items, ...result.data];
    state.nextCursor = result.meta.nextCursor;
  }

  async function refresh({ reset = true } = {}) {
    try {
      await fetchPage({ reset });
      if (reset) clearSelection();
      renderRows();
    } catch (error) {
      toast(`Could not load items: ${error.message}`, true);
    }
  }

  async function loadMore() {
    await refresh({ reset: false });
  }

  statusSelect.addEventListener("change", () => {
    state.filters.status = statusSelect.value;
    refresh();
  });
  assigneeSelect.addEventListener("change", () => {
    state.filters.assignee = assigneeSelect.value;
    refresh();
  });
  labelSelect.addEventListener("change", () => {
    state.filters.label = labelSelect.value;
    refresh();
  });
  searchInput.addEventListener("input", debounce(() => {
    state.filters.q = searchInput.value.trim();
    refresh();
  }, 250));

  const view = el(
    "div",
    { class: "list-view" },
    el(
      "div",
      { class: "list-toolbar" },
      statusSelect,
      assigneeSelect,
      labelSelect,
      searchInput,
    ),
    selectionBar,
    el(
      "table",
      { class: "list-table" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { class: "cell-check" }, ""),
          el("th", {}, "ID"),
          el("th", {}, "Title"),
          el("th", {}, "Status"),
          el("th", {}, "Priority"),
          el("th", {}, "Assignee"),
          el("th", {}, "Labels"),
        ),
      ),
      tableBody,
    ),
    el("div", { class: "list-footer" }, pageInfo, loadMoreButton),
  );

  container.replaceChildren(view);

  // Load reference data for filters, then the first page.
  try {
    const [participants, labels] = await Promise.all([api.listParticipants(), api.listLabels()]);
    state.participants = participants.data;
    state.labels = labels.data;
    for (const participant of state.participants) {
      assigneeSelect.append(el("option", { value: String(participant.id) }, participant.name));
    }
    for (const label of state.labels) {
      labelSelect.append(el("option", { value: label.name }, label.name));
    }
  } catch (error) {
    toast(`Could not load filters: ${error.message}`, true);
  }
  await refresh({ reset: true });
}

registerView("list", { title: "List", href: "#/list", mount });
