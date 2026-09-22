import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import * as apiModule from "../../api.js";
import { isTerminalAuthError } from "../../public-errors.js";
import { createFilterStore } from "../../ui-state.js";
import { isWorkItemType } from "../../views";
import { labelsFromResponse, listPageFromResponse, participantsFromResponse } from "./data";
import { LIST_STATUSES } from "./types";
import type { ListFilters, ListItem, ListLabel, ListParticipant, ListState, ListViewProps } from "./types";

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 250;
export const LIST_LOAD_ERROR = "Could not load work items. Please try again.";
export const LIST_FILTER_ERROR = "Some filter options could not be loaded.";
export const LIST_DATA_ERROR = "Workboard returned list data in an unexpected format.";
export const LIST_PAGINATION_ERROR = "Could not load more work items because pagination did not advance.";

function itemCount(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

interface ApiResponse {
  readonly data: unknown;
  readonly meta?: unknown;
}

interface ListApi {
  listItems: (params: Record<string, string | number>) => Promise<ApiResponse>;
  listParticipants: () => Promise<ApiResponse>;
  listLabels: () => Promise<ApiResponse>;
  updateItem: (id: number, patch: { assigneeId: number | null }) => Promise<unknown>;
}

interface FilterStore {
  load: () => ListFilters;
  set: (filters: ListFilters) => ListFilters;
  commit: (filters: ListFilters) => ListFilters;
  reset: () => ListFilters;
}

interface RefreshIntent {
  readonly reset: boolean;
  readonly preserveSelection: boolean;
  readonly token: number;
}

const api = apiModule as ListApi;

function filterQueryKey(filters: ListFilters): string {
  return JSON.stringify([filters.status, filters.type, filters.assignee, filters.label, filters.q]);
}

export function useList({ refreshGeneration, onAuthenticationFailure }: ListViewProps): ListState {
  const [store] = useState<FilterStore>(() => createFilterStore() as FilterStore);
  const [initialFilters] = useState<ListFilters>(() => {
    const loaded = store.load();
    // A restored status or type the API would reject falls back to "all" rather
    // than reaching a request that cannot succeed; the filters beside it are
    // left untouched, so one stale value cannot silently widen the others.
    const statusValid = loaded.status === "" || LIST_STATUSES.some((status) => status === loaded.status);
    const typeValid = loaded.type === "" || isWorkItemType(loaded.type);
    if (statusValid && typeValid) return loaded;
    return store.set({ ...loaded, status: statusValid ? loaded.status : "", type: typeValid ? loaded.type : "" });
  });

  const mountedRef = useRef(true);
  const terminalRef = useRef(false);
  const authFailureRef = useRef(onAuthenticationFailure);
  const intentTokenRef = useRef(0);
  const runningRef = useRef(false);
  const queuedRef = useRef<RefreshIntent | null>(null);
  const loadedRef = useRef(false);
  const itemsRef = useRef<readonly ListItem[]>([]);
  const seenIdsRef = useRef(new Set<number>());
  const selectedRef = useRef(new Set<number>());
  const nextCursorRef = useRef<string | null>(null);
  const cursorHistoryRef = useRef(new Map<string, Set<string>>());
  const paginationTerminatedRef = useRef(false);
  const filtersRef = useRef<ListFilters>(initialFilters);

  const [items, setItems] = useState<readonly ListItem[]>([]);
  const [participants, setParticipants] = useState<readonly ListParticipant[]>([]);
  const [labels, setLabels] = useState<readonly ListLabel[]>([]);
  const [filters, setFilters] = useState<ListFilters>(initialFilters);
  const [searchDraft, setSearchDraftState] = useState(initialFilters.q);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [paginationTerminated, setPaginationTerminated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  authFailureRef.current = onAuthenticationFailure;

  const active = useCallback((): boolean => mountedRef.current && !terminalRef.current, []);

  const failAuthentication = useCallback((caught: unknown): boolean => {
    if (!isTerminalAuthError(caught)) return false;
    if (!terminalRef.current) {
      terminalRef.current = true;
      intentTokenRef.current += 1;
      queuedRef.current = null;
      authFailureRef.current();
    }
    return true;
  }, []);

  const publishItems = useCallback((next: readonly ListItem[]): void => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const publishSelection = useCallback((next: Set<number>): void => {
    selectedRef.current = next;
    setSelected(next);
  }, []);

  const terminatePagination = useCallback((message: string): void => {
    paginationTerminatedRef.current = true;
    setPaginationTerminated(true);
    setError(message);
    setNotice("");
  }, []);

  const performRefresh = useCallback(async (initial: RefreshIntent): Promise<void> => {
    if (!active()) return;
    if (runningRef.current) {
      queuedRef.current = initial;
      return;
    }
    runningRef.current = true;
    let intent: RefreshIntent | null = initial;
    try {
      while (intent !== null && active()) {
        const current = intent;
        const params: Record<string, string | number> = { limit: PAGE_SIZE };
        const currentFilters = filtersRef.current;
        const queryKey = filterQueryKey(currentFilters);
        const requestedCursor = !current.reset ? nextCursorRef.current : null;
        if (requestedCursor !== null) params.cursor = requestedCursor;
        if (currentFilters.status !== "") params.status = currentFilters.status;
        if (currentFilters.type !== "") params.type = currentFilters.type;
        if (currentFilters.assignee !== "") params.assignee = currentFilters.assignee;
        if (currentFilters.label !== "") params.label = currentFilters.label;
        if (currentFilters.q !== "") params.q = currentFilters.q;

        if (!loadedRef.current || current.reset) setLoading(true);
        else setLoadingMore(true);
        setError("");
        try {
          const response = await api.listItems(params);
          if (!active() || current.token !== intentTokenRef.current) {
            intent = queuedRef.current;
            queuedRef.current = null;
            continue;
          }
          const page = listPageFromResponse(response);
          if (page === null) {
            terminatePagination(LIST_DATA_ERROR);
          } else if (current.reset) {
            const nextSeenIds = new Set(page.items.map((item) => item.id));
            const nextHistory = new Set<string>();
            if (page.nextCursor !== null) nextHistory.add(page.nextCursor);
            cursorHistoryRef.current.set(queryKey, nextHistory);
            seenIdsRef.current = nextSeenIds;
            publishItems(page.items);
            nextCursorRef.current = page.nextCursor;
            setNextCursor(page.nextCursor);
            paginationTerminatedRef.current = false;
            setPaginationTerminated(false);
            if (!current.preserveSelection) publishSelection(new Set());
            loadedRef.current = true;
            setError("");
          } else {
            const history = cursorHistoryRef.current.get(queryKey) ?? new Set<string>();
            const appended = page.items.filter((item) => !seenIdsRef.current.has(item.id));
            const cursorRepeated = page.nextCursor !== null
              && (page.nextCursor === requestedCursor || history.has(page.nextCursor));
            const noProgress = page.nextCursor !== null && appended.length === 0;
            if (cursorRepeated || noProgress) {
              terminatePagination(LIST_PAGINATION_ERROR);
            } else {
              const nextSeenIds = new Set(seenIdsRef.current);
              for (const item of appended) nextSeenIds.add(item.id);
              seenIdsRef.current = nextSeenIds;
              publishItems([...itemsRef.current, ...appended]);
              if (page.nextCursor !== null) history.add(page.nextCursor);
              cursorHistoryRef.current.set(queryKey, history);
              nextCursorRef.current = page.nextCursor;
              setNextCursor(page.nextCursor);
              setError("");
            }
          }
        } catch (caught: unknown) {
          if (active() && current.token === intentTokenRef.current && !failAuthentication(caught)) {
            terminatePagination(LIST_LOAD_ERROR);
            loadedRef.current = true;
          }
        }
        intent = queuedRef.current;
        queuedRef.current = null;
      }
    } finally {
      runningRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [active, failAuthentication, publishItems, publishSelection, terminatePagination]);

  const scheduleRefresh = useCallback((reset: boolean, preserveSelection: boolean): void => {
    if (!active()) return;
    const intent = { reset, preserveSelection, token: ++intentTokenRef.current };
    if (runningRef.current) queuedRef.current = intent;
    else void performRefresh(intent);
  }, [active, performRefresh]);

  const applyFilters = useCallback((next: ListFilters, commit: boolean): void => {
    const stored = commit ? store.commit(next) : store.set(next);
    filtersRef.current = stored;
    setFilters(stored);
    publishSelection(new Set());
    scheduleRefresh(true, false);
  }, [publishSelection, scheduleRefresh, store]);

  const setFilter = useCallback((key: keyof ListFilters, value: string, commit = true): void => {
    applyFilters({ ...filtersRef.current, [key]: value }, commit);
  }, [applyFilters]);

  const setSearchDraft = useCallback((value: string): void => {
    setSearchDraftState(value);
  }, []);

  const initialSearchRef = useRef(true);
  useEffect(() => {
    if (initialSearchRef.current) {
      initialSearchRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      const q = searchDraft.trim();
      if (q !== filtersRef.current.q) applyFilters({ ...filtersRef.current, q }, false);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [applyFilters, searchDraft]);

  const clearFilters = useCallback((): void => {
    const cleared = store.reset();
    filtersRef.current = cleared;
    setFilters(cleared);
    setSearchDraftState("");
    publishSelection(new Set());
    scheduleRefresh(true, false);
  }, [publishSelection, scheduleRefresh, store]);

  const toggleSelected = useCallback((id: number, checked: boolean): void => {
    if (bulkBusy || !itemsRef.current.some((item) => item.id === id)) return;
    const next = new Set(selectedRef.current);
    if (checked) next.add(id);
    else next.delete(id);
    publishSelection(next);
  }, [bulkBusy, publishSelection]);

  const toggleAll = useCallback((checked: boolean): void => {
    if (bulkBusy) return;
    const next = new Set(selectedRef.current);
    for (const item of itemsRef.current) {
      if (checked) next.add(item.id);
      else next.delete(item.id);
    }
    publishSelection(next);
  }, [bulkBusy, publishSelection]);

  const clearSelection = useCallback((): void => publishSelection(new Set()), [publishSelection]);

  const bulkAssign = useCallback((participantId: number | null): void => {
    if (!active() || bulkBusy || selectedRef.current.size === 0) return;
    const ids = [...selectedRef.current];
    setBulkBusy(true);
    setError("");
    setNotice(`Updating ${itemCount(ids.length)}…`);
    void Promise.allSettled(ids.map((id) => api.updateItem(id, { assigneeId: participantId }))).then((results) => {
      if (!active()) return;
      const terminal = results.find((result) => result.status === "rejected" && isTerminalAuthError(result.reason));
      if (terminal?.status === "rejected") {
        failAuthentication(terminal.reason);
        return;
      }
      const failed = results.filter((result) => result.status === "rejected").length;
      setNotice(failed === 0
        ? `Updated ${itemCount(ids.length)}.`
        : `${failed} of ${ids.length} updates failed. The list was refreshed to show saved changes.`);
      publishSelection(new Set());
      scheduleRefresh(true, false);
    }).finally(() => {
      if (mountedRef.current && !terminalRef.current) setBulkBusy(false);
    });
  }, [active, bulkBusy, failAuthentication, publishSelection, scheduleRefresh]);

  useEffect(() => {
    void (async () => {
      const [participantResult, labelResult] = await Promise.allSettled([api.listParticipants(), api.listLabels()]);
      if (!active()) return;
      if (participantResult.status === "rejected" && failAuthentication(participantResult.reason)) return;
      if (labelResult.status === "rejected" && failAuthentication(labelResult.reason)) return;

      const nextParticipants = participantResult.status === "fulfilled"
        ? participantsFromResponse(participantResult.value)
        : null;
      const nextLabels = labelResult.status === "fulfilled" ? labelsFromResponse(labelResult.value) : null;
      setParticipants(nextParticipants ?? []);
      setLabels(nextLabels ?? []);
      if (nextParticipants === null || nextLabels === null) setNotice(LIST_FILTER_ERROR);

      let nextFilters = filtersRef.current;
      const assigneeValid = nextParticipants === null
        || nextFilters.assignee === ""
        || nextFilters.assignee === "unassigned"
        || nextParticipants.some((participant) => String(participant.id) === nextFilters.assignee);
      const labelValid = nextLabels === null
        || nextFilters.label === ""
        || nextLabels.some((label) => label.name === nextFilters.label);
      if (!assigneeValid || !labelValid) {
        nextFilters = store.set({
          ...nextFilters,
          assignee: assigneeValid ? nextFilters.assignee : "",
          label: labelValid ? nextFilters.label : "",
        });
        filtersRef.current = nextFilters;
        setFilters(nextFilters);
      }
      scheduleRefresh(true, false);
    })();
  }, [active, failAuthentication, scheduleRefresh, store]);

  const initialGenerationRef = useRef(refreshGeneration);
  useEffect(() => {
    if (refreshGeneration === initialGenerationRef.current) return;
    initialGenerationRef.current = refreshGeneration;
    scheduleRefresh(true, true);
  }, [refreshGeneration, scheduleRefresh]);

  useEffect(() => () => {
    mountedRef.current = false;
    intentTokenRef.current += 1;
    queuedRef.current = null;
  }, []);

  return {
    items,
    participants,
    labels,
    filters,
    selected,
    nextCursor,
    canLoadMore: nextCursor !== null && !paginationTerminated,
    loading,
    loadingMore,
    bulkBusy,
    error,
    notice,
    setFilter,
    setSearchDraft,
    searchDraft,
    clearFilters,
    toggleSelected,
    toggleAll,
    clearSelection,
    bulkAssign,
    loadMore: () => {
      if (!paginationTerminatedRef.current && nextCursorRef.current !== null) scheduleRefresh(false, true);
    },
    retry: () => scheduleRefresh(true, true),
  };
}
