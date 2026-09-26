import { useEffect, useRef } from "preact/hooks";
import { WORK_ITEM_TYPE_LABELS, WORK_ITEM_TYPES } from "../../../domain/types";
import { workItemTypeBadge } from "../../views";
import type { ListItem, ListState } from "./types";

// Mirrors BOARD_COLUMN_LABELS so the same status never reads differently in the
// list than it does on the board column it came from.
const STATUS_LABELS: Readonly<Record<string, string>> = {
  todo: "To do",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
};

interface SelectionBarProps {
  list: ListState;
}

export function SelectionBar({ list }: SelectionBarProps) {
  if (list.selected.size === 0) return null;
  return (
    <div class="selection-bar" role="group" aria-label="Bulk actions">
      <strong>{list.selected.size} selected</strong>
      <label class="selection-assign">
        <span>Assign selected to</span>
        <select
          name="bulk-assignee"
          autoComplete="off"
          value=""
          disabled={list.bulkBusy}
          onChange={(event) => {
            const participantId = Number(event.currentTarget.value);
            if (Number.isSafeInteger(participantId) && participantId > 0) list.bulkAssign(participantId);
          }}
        >
          <option value="">Choose assignee…</option>
          {list.participants.map((participant) => (
            <option key={participant.id} value={String(participant.id)}>
              {participant.name}{participant.kind === "agent" ? " (agent)" : ""}
            </option>
          ))}
        </select>
      </label>
      <button type="button" disabled={list.bulkBusy} onClick={() => list.bulkAssign(null)}>Unassign</button>
      <button type="button" disabled={list.bulkBusy} onClick={list.clearSelection}>Clear selection</button>
    </div>
  );
}

interface FilterBarProps {
  list: ListState;
}

export function FilterBar({ list }: FilterBarProps) {
  const active = Object.values(list.filters).some((value) => value !== "") || list.searchDraft.trim() !== "";
  return (
    <fieldset class="list-toolbar" aria-label="Filter work items">
      <label>
        <span class="sr-only">Status</span>
        <select
          name="status"
          autoComplete="off"
          value={list.filters.status}
          disabled={list.bulkBusy}
          onChange={(event) => list.setFilter("status", event.currentTarget.value, true)}
        >
          <option value="">All statuses</option>
          <option value="todo">To do</option>
          <option value="doing">Doing</option>
          <option value="blocked">Blocked</option>
          <option value="done">Done</option>
        </select>
      </label>
      <label>
        <span class="sr-only">Type</span>
        <select
          name="type"
          autoComplete="off"
          value={list.filters.type}
          disabled={list.bulkBusy}
          onChange={(event) => list.setFilter("type", event.currentTarget.value, true)}
        >
          <option value="">All types</option>
          {/* The option values are the domain's wire types, so the control can
              only ever offer a value the API accepts. */}
          {WORK_ITEM_TYPES.map((type) => (
            <option key={type} value={type}>{WORK_ITEM_TYPE_LABELS[type]}</option>
          ))}
        </select>
      </label>
      <label>
        <span class="sr-only">Assignee</span>
        <select
          name="assignee"
          autoComplete="off"
          value={list.filters.assignee}
          disabled={list.bulkBusy}
          onChange={(event) => list.setFilter("assignee", event.currentTarget.value, true)}
        >
          <option value="">Any assignee</option>
          <option value="unassigned">Unassigned</option>
          {list.participants.map((participant) => (
            <option key={participant.id} value={String(participant.id)}>
              {participant.name}{participant.kind === "agent" ? " (agent)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span class="sr-only">Label</span>
        <select
          name="label"
          autoComplete="off"
          value={list.filters.label}
          disabled={list.bulkBusy}
          onChange={(event) => list.setFilter("label", event.currentTarget.value, true)}
        >
          <option value="">Any label</option>
          {list.labels.map((label) => <option key={label.id} value={label.name}>{label.name}</option>)}
        </select>
      </label>
      <label class="list-search-label">
        <span class="sr-only">Search titles</span>
        <input
          type="search"
          name="title-search"
          autoComplete="off"
          class="search-field"
          value={list.searchDraft}
          disabled={list.bulkBusy}
          placeholder="Search titles…"
          onInput={(event) => list.setSearchDraft(event.currentTarget.value)}
        />
      </label>
      {active ? <button type="button" class="clear-filters" disabled={list.bulkBusy} onClick={list.clearFilters}>Clear filters</button> : null}
    </fieldset>
  );
}

function ItemRow({ item, list }: { item: ListItem; list: ListState }) {
  const typeBadge = workItemTypeBadge(item.type);
  return (
    <tr data-id={String(item.id)}>
      <td class="cell-check">
        <label class="checkbox-hit-area">
          <input
            type="checkbox"
            name={`select-item-${item.id}`}
            aria-label={`Select work item #${item.id}`}
            checked={list.selected.has(item.id)}
            disabled={list.bulkBusy}
            onChange={(event) => list.toggleSelected(item.id, event.currentTarget.checked)}
          />
        </label>
      </td>
      <td class="muted" data-label="ID"><a class="list-item-id" href={`#/item/${item.id}`}>#{item.id}</a></td>
      <td data-label="Title"><a class="list-item-title" href={`#/item/${item.id}`}>{item.title}</a></td>
      <td data-label="Status"><span class={`chip status-chip status-${item.status}`}>{STATUS_LABELS[item.status] ?? item.status}</span></td>
      <td data-label="Type">
        <span class={typeBadge.className} title={typeBadge.label}>
          <span class="type-mark" aria-hidden="true">{typeBadge.mark}</span>{typeBadge.label}
        </span>
      </td>
      <td data-label="Priority"><span class={`chip p${item.priority}`}>P{item.priority}</span></td>
      <td data-label="Assignee">
        {item.assignee === null
          ? "—"
          : item.assignee.kind === "agent"
            ? `${item.assignee.name} (agent)`
            : item.assignee.name}
      </td>
      <td data-label="Labels">
        <div class="list-labels">
          {item.labels.map((label) => <span key={label.id} class="chip label-chip">{label.name}</span>)}
        </div>
      </td>
    </tr>
  );
}

export function ItemTable({ list }: { list: ListState }) {
  const selectAllRef = useRef<HTMLInputElement>(null);
  const hasFilters = Object.values(list.filters).some((value) => value !== "") || list.searchDraft.trim() !== "";
  const allSelected = list.items.length > 0 && list.items.every((item) => list.selected.has(item.id));
  const someSelected = list.items.some((item) => list.selected.has(item.id));
  useEffect(() => {
    if (selectAllRef.current !== null) selectAllRef.current.indeterminate = someSelected && !allSelected;
  }, [allSelected, someSelected]);

  return (
    <div class="list-table-scroller" tabIndex={0} role="region" aria-label="Work items table">
      <table class="list-table">
        <caption class="sr-only">Filtered work items</caption>
        <thead>
          <tr>
            <th class="cell-check" scope="col">
              <label class="checkbox-hit-area">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  name="select-all-loaded-items"
                  aria-label="Select all loaded work items"
                  checked={allSelected}
                  disabled={list.bulkBusy || list.items.length === 0}
                  onChange={(event) => list.toggleAll(event.currentTarget.checked)}
                />
              </label>
            </th>
            <th scope="col">ID</th>
            <th scope="col">Title</th>
            <th scope="col">Status</th>
            <th scope="col">Type</th>
            <th scope="col">Priority</th>
            <th scope="col">Assignee</th>
            <th scope="col">Labels</th>
          </tr>
        </thead>
        <tbody>
          {list.items.map((item) => <ItemRow key={item.id} item={item} list={list} />)}
          {!list.loading && list.items.length === 0 ? (
            <tr class="list-empty-row"><td colSpan={8}><div class="empty-state"><strong>{hasFilters ? "No work items match these filters." : "No work items yet"}</strong><span>{hasFilters ? "Try broadening or clearing your filters." : "New work will appear here when it is created."}</span></div></td></tr>
          ) : null}
          {list.loading && list.items.length === 0 ? (
            <tr class="list-empty-row"><td colSpan={8}><div class="empty-state"><strong>Loading work items…</strong><span>Preparing the current view.</span></div></td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
