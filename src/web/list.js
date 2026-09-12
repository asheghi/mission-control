// List view (Task 14): filterable, cursor-paginated table with bulk assign.
// Filters are URL/hash-backed (`#/list?status=doing&q=parse`) so a filtered
// view is shareable, survives reload, and local storage keeps the last set
// when the URL carries no query.
import * as api from "./api.js";
import { el, toast, navigate } from "./app.js";
import { createDebounced, createFilterStore, hasActiveFilters } from "./ui-state.js";
import { registerView } from "./views.js";

const STATUSES = ["todo", "doing", "blocked", "done"];
const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 250;

async function mount(params, container) {
  const state = {
    items: [],
    nextCursor: null,
    participants: [],
    labels: [],
    selected: new Set(),
    filters: { status: "", assignee: "", label: "", q: "" },
  };

  // Every async step checks this before touching the DOM or the URL: a mount
  // whose view was replaced (route change, refresh, sign-out) must not rewrite
  // another route's hash or fetch pages nobody will ever see.
  let alive = true;

  // Restore from the URL hash first, then local storage, then empty.
  const filterStore = createFilterStore();
  state.filters = filterStore.load();

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
  const searchInput = el("input", { type: "search", class: "search-field", placeholder: "Search titles…", "aria-label": "Search titles" });
  const loadMoreButton = el("button", { onclick: () => loadMore() }, "Load more");
  const pageInfo = el("span", { class: "muted" });
  const clearFiltersButton = el("button", { type: "button", class: "clear-filters", onclick: () => resetFilters() }, "Clear filters");

  // Reflect the restored filters in the controls before the first fetch.
  statusSelect.value = state.filters.status;
  assigneeSelect.value = state.filters.assignee;
  searchInput.value = state.filters.q;

  /**
   * A `<select>` silently falls back to its first option when the requested
   * value has no option yet, so the control and the filter state drift apart.
   * After the option set changes, reapply the stored value and *validate* it:
   * a value with no matching option (stale shared link, deleted label) is
   * cleared in state and in the URL instead of leaving the list filtered by
   * something the user cannot see or reset from the control.
   */
  function reapplySelectFilter(select, key, hasOption) {
    const desired = state.filters[key];
    if (desired !== "" && !hasOption(desired)) {
      state.filters[key] = "";
      filterStore.set(state.filters);
      select.value = "";
      syncClearButton();
      return false;
    }
    select.value = desired;
    return select.value === desired;
  }

  function reapplyAssigneeFilter() {
    return reapplySelectFilter(
      assigneeSelect,
      "assignee",
      // "unassigned" is a real filter value with its own static option.
      (value) => value === "unassigned" || state.participants.some((participant) => String(participant.id) === value),
    );
  }

  function reapplyLabelFilter() {
    return reapplySelectFilter(labelSelect, "label", (value) => state.labels.some((label) => label.name === value));
  }

  function syncClearButton() {
    clearFiltersButton.toggleAttribute("hidden", !hasActiveFilters(state.filters));
  }

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
        role: "link",
        "aria-label": `Open work item #${item.id}: ${item.title}`,
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
    if (!alive) return;
    state.items = reset ? result.data : [...state.items, ...result.data];
    state.nextCursor = result.meta.nextCursor;
  }

  async function refresh({ reset = true } = {}) {
    if (!alive) return;
    try {
      await fetchPage({ reset });
      if (!alive) return; // the view was replaced while the page was in flight
      if (reset) clearSelection();
      renderRows();
    } catch (error) {
      if (!alive) return;
      toast(`Could not load items: ${error.message}`, true);
    }
  }

  async function loadMore() {
    await refresh({ reset: false });
  }

  statusSelect.addEventListener("change", () => {
    state.filters.status = statusSelect.value;
    filterStore.commit(state.filters);
    syncClearButton();
    refresh();
  });
  assigneeSelect.addEventListener("change", () => {
    state.filters.assignee = assigneeSelect.value;
    filterStore.commit(state.filters);
    syncClearButton();
    refresh();
  });
  labelSelect.addEventListener("change", () => {
    state.filters.label = labelSelect.value;
    filterStore.commit(state.filters);
    syncClearButton();
    refresh();
  });

  // Typing stays out of history (replaceState), so the router does not remount
  // and steal focus on every keystroke. The debounce is cancellable, and it is
  // cancelled on unmount (see the cleanup registration below): without that, a
  // keystroke typed just before a route change would fire afterwards and rewrite
  // the *new* route's hash.
  const searchDebounce = createDebounced({
    delayMs: SEARCH_DEBOUNCE_MS,
    fn: () => {
      if (!alive) return;
      state.filters.q = searchInput.value.trim();
      filterStore.set(state.filters);
      syncClearButton();
      refresh();
    },
  });
  searchInput.addEventListener("input", () => {
    searchDebounce.schedule();
  });

  function resetFilters() {
    searchDebounce.cancel();
    state.filters = filterStore.reset();
    statusSelect.value = "";
    assigneeSelect.value = "";
    labelSelect.value = "";
    searchInput.value = "";
    syncClearButton();
    refresh({ reset: true });
  }

  const view = el(
    "div",
    { class: "list-view" },
    el("div", { class: "page-header" }, el("div", {}, el("h1", {}, "All work"), el("p", {}, "Search, filter, and manage every item in one place."))),
    el(
      "div",
      { class: "list-toolbar", "aria-label": "Filter work items" },
      statusSelect,
      assigneeSelect,
      labelSelect,
      searchInput,
      clearFiltersButton,
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
          el("th", { class: "cell-check" }, el("span", { class: "sr-only" }, "Select")),
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

  // Unmount hook: cancel pending search work and reject late writes, so a
  // keystroke typed just before a route change can never fire afterwards and
  // rewrite the *new* route's hash. The router calls this before it swaps the
  // view out; it is idempotent and safe to call after the view is gone.
  view.unmount = () => {
    if (!alive) return;
    alive = false;
    searchDebounce.cancel();
  };

  // Load reference data for filters, then the first page.
  try {
    const [participants, labels] = await Promise.all([api.listParticipants(), api.listLabels()]);
    if (!alive) return;
    state.participants = participants.data;
    state.labels = labels.data;
    for (const participant of state.participants) {
      assigneeSelect.append(el("option", { value: String(participant.id) }, participant.name));
    }
    for (const label of state.labels) {
      labelSelect.append(el("option", { value: label.name }, label.name));
    }
    // A label restored from the URL may not exist any more; fall back to "any"
    // rather than leaving the select stuck on a missing option.
    reapplyLabelFilter();
    // Assignee filter options load asynchronously: reapply the restored value
    // once they exist, otherwise a deep link such as #/list?assignee=7 renders
    // the "Any assignee" placeholder while the list is actually filtered.
    reapplyAssigneeFilter();
  } catch (error) {
    if (!alive) return;
    toast(`Could not load filters: ${error.message}`, true);
  }
  syncClearButton();
  await refresh({ reset: true });
  // Returning the node lets the router track and later unmount this view.
  return view;
}

registerView("list", { title: "List", href: "#/list", mount });
