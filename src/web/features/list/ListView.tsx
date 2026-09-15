import { FilterBar, ItemTable, SelectionBar } from "./components";
import { useList } from "./hooks";
import type { ListViewProps } from "./types";

export function ListView(props: ListViewProps) {
  const list = useList(props);
  const status = list.bulkBusy
    ? `Updating ${list.selected.size} selected item(s)…`
    : list.loading
      ? (list.items.length === 0 ? "Loading work items…" : "Refreshing work items…")
      : list.loadingMore
        ? "Loading more work items…"
        : list.notice;

  return (
    <div class="list-view">
      <div class="page-header">
        <div>
          <h1>All work</h1>
          <p>Search, filter, and manage every item in one place.</p>
        </div>
      </div>

      <FilterBar list={list} />
      <div class="list-status sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</div>

      {list.error !== "" ? (
        <div class="error-banner" role="alert">
          {list.error} <button type="button" disabled={list.bulkBusy} onClick={list.retry}>Retry</button>
        </div>
      ) : null}
      {list.notice !== "" ? <div class="list-notice">{list.notice}</div> : null}

      <SelectionBar list={list} />
      <ItemTable list={list} />

      <div class="list-footer">
        <span class="muted">{list.items.length} item(s) loaded</span>
        {list.canLoadMore ? (
          <button type="button" disabled={list.loading || list.loadingMore || list.bulkBusy} onClick={list.loadMore}>
            {list.loadingMore ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
