import { useCallback, useEffect, useState } from "preact/hooks";
import * as api from "../../api.js";
import { isTerminalAuthError } from "../../public-errors.js";
import { backlogPageFromResponse, groupBacklog } from "./data";
import type { BacklogItem, BacklogViewProps } from "./types";

export function BacklogView({ refreshGeneration, onAuthenticationFailure }: BacklogViewProps) {
  const [items, setItems] = useState<readonly BacklogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
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
      setError("");
    } catch (caught: unknown) {
      if (isTerminalAuthError(caught)) onAuthenticationFailure();
      else setError("Could not load the backlog. Please try again.");
    } finally { setLoading(false); }
  }, [onAuthenticationFailure]);
  useEffect(() => { void refresh(); }, [refresh, refreshGeneration]);
  const groups = groupBacklog(items);
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
      {!loading && groups.length === 0 ? <div class="empty-state card"><strong>No backlog items</strong>Add an item when you are ready to plan what comes next.</div> : (
        <ul class="backlog-groups" aria-label="Backlog items">{groups.map((group) => (
          <li class="backlog-group card" key={group.item.id}>
            <div class="backlog-row backlog-root"><span class={`chip p${group.item.priority}`}>P{group.item.priority}</span><a href={`#/item/${group.item.id}`}><span class="muted">#{group.item.id}</span> {group.item.title}</a><span class="chip">{group.children.length} open sub-task{group.children.length === 1 ? "" : "s"}</span></div>
            {group.children.length === 0 ? null : <ul class="backlog-children">{group.children.map((child) => <li class="backlog-row" key={child.id}><span class={`chip p${child.priority}`}>P{child.priority}</span><a href={`#/item/${child.id}`}><span class="muted">#{child.id}</span> {child.title}</a>{child.assignee === null ? null : <span class="muted">{child.assignee.name}{child.assignee.kind === "agent" ? " · agent" : ""}</span>}</li>)}</ul>}
          </li>
        ))}</ul>
      )}
    </div>
  );
}
