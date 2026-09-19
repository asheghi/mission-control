import { useCallback, useEffect, useState } from "preact/hooks";
import * as api from "../../api.js";
import { isTerminalAuthError } from "../../public-errors.js";
import { backlogPageFromResponse, groupBacklog } from "./data";
import type { BacklogGroup, BacklogItem, BacklogViewProps } from "./types";

/** Item, Priority, Assignee, Labels — used by the loading and empty rows. */
const COLUMN_COUNT = 4;

function subTaskCount(count: number): string {
  return `${count} ${count === 1 ? "sub-task" : "sub-tasks"}`;
}

interface BacklogRowProps {
  readonly node: BacklogGroup;
  readonly level: number;
  readonly expanded: ReadonlySet<number>;
  readonly onToggle: (id: number) => void;
}

/**
 * One table row per work item, plus the rows of every expanded descendant.
 *
 * Every item with children starts collapsed: `expanded` is empty on first
 * render and only ever holds ids the user opened. Nesting is expressed as an
 * `aria-level` on the row and one indent spacer per ancestor, so the tree stays
 * a single aligned table rather than a table nested inside a cell.
 */
function BacklogRows({ node, level, expanded, onToggle }: BacklogRowProps) {
  const { item, children } = node;
  const hasChildren = children.length > 0;
  const isExpanded = hasChildren && expanded.has(item.id);
  return (
    <>
      <tr class={level > 1 ? "backlog-child-row" : ""} aria-level={level}>
        <td class="backlog-item-cell" data-label="Item">
          <div class="backlog-item-title">
            {Array.from({ length: level - 1 }, (_, depth) => <span class="backlog-indent" key={depth} aria-hidden="true" />)}
            {hasChildren ? (
              <button
                class="backlog-toggle"
                type="button"
                aria-expanded={isExpanded}
                aria-label={`${isExpanded ? "Collapse" : "Expand"} ${item.title} (${subTaskCount(children.length)})`}
                onClick={() => onToggle(item.id)}
              >
                <span aria-hidden="true">›</span>
              </button>
            ) : <span class="backlog-toggle-spacer" aria-hidden="true" />}
            <a href={`#/item/${item.id}`}><span class="muted">#{item.id}</span> {item.title}</a>
            {hasChildren ? <span class="backlog-child-count" aria-hidden="true">{children.length}</span> : null}
          </div>
        </td>
        <td data-label="Priority"><span class={`chip p${item.priority}`}>P{item.priority}</span></td>
        <td data-label="Assignee">{item.assignee === null ? <span class="muted">Unassigned</span> : <span>{item.assignee.name}{item.assignee.kind === "agent" ? <span class="muted"> (agent)</span> : null}</span>}</td>
        <td data-label="Labels"><div class="backlog-labels">{item.labels.map((label) => <span class="chip label-chip" key={label.id}>{label.name}</span>)}</div></td>
      </tr>
      {isExpanded ? children.map((child) => <BacklogRows key={child.item.id} node={child} level={level + 1} expanded={expanded} onToggle={onToggle} />) : null}
    </>
  );
}

export function BacklogView({ refreshGeneration, onAuthenticationFailure }: BacklogViewProps) {
  const [items, setItems] = useState<readonly BacklogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const loaded: BacklogItem[] = [];
      const seen = new Set<number>();
      let cursor: string | null = null;
      do {
        const response = await api.listItems({ status: "todo", limit: 100, ...(cursor === null ? {} : { cursor }) });
        const page = backlogPageFromResponse(response);
        if (page === null) throw new Error("invalid backlog response");
        for (const item of page.items) {
          if (seen.has(item.id)) throw new Error("repeated backlog item");
          seen.add(item.id);
          loaded.push(item);
        }
        if (cursor !== null && page.nextCursor === cursor) throw new Error("repeated backlog cursor");
        cursor = page.nextCursor;
      } while (cursor !== null);
      setItems(loaded);
      // Rows that disappeared must not keep an expanded id alive, or a reused
      // id would come back already open.
      setExpanded((current) => new Set([...current].filter((id) => seen.has(id))));
      setError("");
    } catch (caught: unknown) {
      if (isTerminalAuthError(caught)) onAuthenticationFailure();
      else setError("Could not load the backlog. Please try again.");
    } finally { setLoading(false); }
  }, [onAuthenticationFailure]);
  useEffect(() => { void refresh(); }, [refresh, refreshGeneration]);
  const groups = groupBacklog(items);
  const toggle = useCallback((id: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  return (
    <div class="backlog-view">
      <div class="page-header"><div><h1>Backlog</h1><p>Shape upcoming work and break it into manageable sub-tasks.</p></div></div>
      <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{loading ? "Loading backlog…" : error !== "" ? error : `${items.length} backlog items loaded`}</div>
      {error === "" ? null : <div class="error-banner" role="alert">{error}<button type="button" onClick={() => void refresh()}>Retry</button></div>}
      <form class="backlog-add card" onSubmit={(event) => {
        event.preventDefault();
        const title = draft.trim();
        if (title === "" || adding) return;
        setAdding(true);
        void api.createItem({ title }).then(() => { setDraft(""); return refresh(); }).catch((caught: unknown) => {
          if (isTerminalAuthError(caught)) onAuthenticationFailure(); else setError("Could not add the item. Please try again.");
        }).finally(() => setAdding(false));
      }}>
        <label for="backlog-add-title">Add backlog item</label>
        <div><input id="backlog-add-title" name="title" autoComplete="off" value={draft} maxLength={256} placeholder="Add an upcoming work item…" disabled={adding} onInput={(event) => setDraft(event.currentTarget.value)} /><button class="primary" type="submit" disabled={adding || draft.trim() === ""}>{adding ? "Adding…" : "Add item"}</button></div>
      </form>
      <div class="backlog-table-scroller" tabIndex={0} role="region" aria-label="Backlog items table">
        <table class="backlog-table">
          <caption class="sr-only">Backlog items, with sub-tasks nested under their parent</caption>
          <thead><tr><th scope="col">Item</th><th scope="col">Priority</th><th scope="col">Assignee</th><th scope="col">Labels</th></tr></thead>
          <tbody>
            {groups.map((group) => <BacklogRows key={group.item.id} node={group} level={1} expanded={expanded} onToggle={toggle} />)}
            {loading && items.length === 0 ? (
              <tr class="backlog-empty-row"><td colSpan={COLUMN_COUNT}><div class="empty-state"><strong>Loading backlog…</strong><span>Preparing the current view.</span></div></td></tr>
            ) : null}
            {!loading && groups.length === 0 ? (
              <tr class="backlog-empty-row"><td colSpan={COLUMN_COUNT}><div class="empty-state"><strong>No backlog items</strong><span>Add an item when you are ready to plan what comes next.</span></div></td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
