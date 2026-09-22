import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { WorkItemType } from "../../../domain/types";
import { WORK_ITEM_TYPES } from "../../../domain/types";
import { isTerminalAuthError } from "../../public-errors.js";
import { backlogPageFromResponse, groupBacklog } from "./data";
import { rootRefusalMessage } from "./moves";
import type { BacklogItem, BacklogMove, BacklogMoveAttempt, BacklogState, BacklogViewProps } from "./types";

/**
 * The three backlog endpoints this view drives, injected rather than imported
 * so the API client stays behind the single import the view already owns.
 */
export interface BacklogApi {
  readonly listBacklog: () => Promise<{ data: unknown }>;
  readonly createItem: (input: { title: string; type: string }) => Promise<{ data: unknown }>;
  readonly reorderItem: (
    id: number,
    input: { parentId: number | null; beforeId: number | null },
  ) => Promise<{ data: unknown }>;
}

export const BACKLOG_LOAD_ERROR = "Could not load the backlog. Please try again.";
export const BACKLOG_ADD_ERROR = "Could not add the item. Please try again.";
export const BACKLOG_MOVE_ERROR = "Could not move the item. Its previous place was restored.";

export const DEFAULT_QUICK_ADD_TYPE: WorkItemType = "user_story";

function isQuickAddType(value: unknown): value is WorkItemType {
  return typeof value === "string" && (WORK_ITEM_TYPES as readonly string[]).includes(value);
}

/**
 * Backlog state: one unpaginated read, one optimistic move at a time.
 *
 * The whole view is driven from a single `listBacklog()` request — backlog
 * order is positional, so paging it would silently drop the tail — and any
 * accepted move is confirmed by re-reading that same endpoint rather than by
 * trusting the response, which keeps the rendered order exactly the order the
 * server would produce on the next load.
 */
export function useBacklog(api: BacklogApi, { refreshGeneration, onAuthenticationFailure }: BacklogViewProps): BacklogState {
  const mountedRef = useRef(true);
  const terminalRef = useRef(false);
  const authFailureRef = useRef(onAuthenticationFailure);
  const generationRef = useRef(0);
  const loadedRef = useRef(false);
  const canonicalRef = useRef<readonly BacklogItem[]>([]);
  // At most one move may be shown as applied-but-unconfirmed. While it is set,
  // another move is refused rather than queued, so the screen can never show
  // two unconfirmed positions at once.
  const inFlightRef = useRef<number | null>(null);
  const expandedRef = useRef<ReadonlySet<number>>(new Set());

  const [canonical, setCanonical] = useState<readonly BacklogItem[]>([]);
  const [overlay, setOverlay] = useState<{ readonly id: number; readonly items: readonly BacklogItem[] } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [moveAttempt, setMoveAttempt] = useState<BacklogMoveAttempt | null>(null);
  const [refusal, setRefusal] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [addNotice, setAddNotice] = useState("");
  const [quickAddType, setQuickAddType] = useState<WorkItemType>(DEFAULT_QUICK_ADD_TYPE);

  authFailureRef.current = onAuthenticationFailure;

  const isActive = useCallback((): boolean => mountedRef.current && !terminalRef.current, []);

  const setCanonicalItems = useCallback((items: readonly BacklogItem[]): void => {
    canonicalRef.current = items;
    setCanonical(items);
  }, []);

  const setExpandedIds = useCallback((next: ReadonlySet<number>): void => {
    expandedRef.current = next;
    setExpanded(next);
  }, []);

  const terminalAuthentication = useCallback((caught: unknown): boolean => {
    if (!isTerminalAuthError(caught)) return false;
    if (!terminalRef.current) {
      terminalRef.current = true;
      // Bumping the generation retires every request already in flight, and
      // clearing the in-flight marker drops the optimistic position, so no
      // further fetch is started from this view.
      generationRef.current += 1;
      inFlightRef.current = null;
      setOverlay(null);
      setBusy(false);
      setAdding(false);
      authFailureRef.current();
    }
    return true;
  }, []);

  const refreshBacklog = useCallback(async (preserveMessage = false): Promise<boolean> => {
    if (!isActive()) return false;
    const generation = ++generationRef.current;
    if (!loadedRef.current) setLoading(true);
    try {
      const response = await api.listBacklog();
      if (!isActive() || generation !== generationRef.current) return false;
      const page = backlogPageFromResponse(response);
      if (page === null) {
        loadedRef.current = true;
        setLoading(false);
        setError(BACKLOG_LOAD_ERROR);
        return false;
      }
      const ids = new Set(page.items.map((item) => item.id));
      setCanonicalItems(page.items);
      // Rows that disappeared must not keep an expanded id alive, or a reused
      // id would come back already open.
      setExpandedIds(new Set([...expandedRef.current].filter((id) => ids.has(id))));
      loadedRef.current = true;
      setLoading(false);
      if (!preserveMessage) setError("");
      return true;
    } catch (caught: unknown) {
      if (!isActive() || generation !== generationRef.current) return false;
      if (terminalAuthentication(caught)) return false;
      loadedRef.current = true;
      setLoading(false);
      setError(BACKLOG_LOAD_ERROR);
      return false;
    }
  }, [api, isActive, setCanonicalItems, setExpandedIds, terminalAuthentication]);

  useEffect(() => {
    void refreshBacklog();
  }, [refreshBacklog, refreshGeneration]);

  useEffect(() => () => {
    mountedRef.current = false;
    generationRef.current += 1;
  }, []);

  // The optimistic position is only ever a re-parented copy of the canonical
  // list, so an item that vanished between the two reads cannot be resurrected.
  const items = overlay === null ? canonical : overlay.items;
  const groups = useMemo(() => groupBacklog(items), [items]);

  /**
   * Record a move the view refuses locally. Both refusal paths — a Task at the
   * top level, and a second move while one is in flight — go through here so
   * the reason reaches the live region and the banner exactly once, whichever
   * gesture produced it. Nothing is sent, so nothing is rolled back.
   */
  const refuse = useCallback((itemId: number, message: string): void => {
    if (!isActive()) return;
    setMoveAttempt({ moveId: itemId, message, focusRowId: itemId });
    setRefusal(message);
    setStatus("");
  }, [isActive]);

  const clearRefusal = useCallback((): void => {
    setRefusal("");
    setMoveAttempt(null);
  }, []);

  const move = useCallback((intent: BacklogMove): void => {
    if (!isActive()) return;
    const current = canonicalRef.current.find((item) => item.id === intent.itemId);
    if (current === undefined) return;
    // A Task cannot be top level. Refuse it here, with the reason, and send no
    // request at all: a rejected round trip would tell the user less.
    if (current.type === "task" && intent.parentId === null) {
      refuse(current.id, rootRefusalMessage(current));
      return;
    }
    if (inFlightRef.current !== null) {
      refuse(intent.itemId, "Another move is still being saved. Try again in a moment.");
      return;
    }

    inFlightRef.current = intent.itemId;
    setMoveAttempt(null);
    setRefusal("");
    setError("");
    setBusy(true);
    setStatus(`Moving ${current.title}\u2026`);
    const projected = optimisticOrder(canonicalRef.current, intent);
    setOverlay(projected === null ? null : { id: intent.itemId, items: projected });

    void (async () => {
      try {
        await api.reorderItem(intent.itemId, { parentId: intent.parentId, beforeId: intent.beforeId });
        if (!isActive()) return;
        // The response only proves the write was accepted; the order it
        // produces is read back authoritatively rather than reconstructed. The
        // overlay stays up until that read lands, so the row never flickers back
        // to the pre-move order between the two.
        const confirmed = await refreshBacklog(true);
        if (!isActive()) return;
        setStatus(confirmed ? intent.announcement : BACKLOG_MOVE_ERROR);
        if (!confirmed) setError(BACKLOG_MOVE_ERROR);
      } catch (caught: unknown) {
        if (!isActive() || terminalAuthentication(caught)) return;
        // Roll back: the canonical list is untouched, so dropping the overlay
        // restores exactly the position the row had before the attempt.
        setOverlay(null);
        setStatus("");
        setError(BACKLOG_MOVE_ERROR);
        setMoveAttempt({ moveId: intent.itemId, message: BACKLOG_MOVE_ERROR, focusRowId: intent.itemId });
        await refreshBacklog(true);
      } finally {
        if (inFlightRef.current === intent.itemId) inFlightRef.current = null;
        if (mountedRef.current && !terminalRef.current) {
          setBusy(false);
          setOverlay(null);
        }
      }
    })();
  }, [api, isActive, refuse, refreshBacklog, terminalAuthentication]);

  const toggle = useCallback((id: number): void => {
    const next = new Set(expandedRef.current);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  }, [setExpandedIds]);

  const addItem = useCallback((title: string): void => {
    const trimmed = title.trim();
    if (!isActive() || trimmed === "" || adding) return;
    setAdding(true);
    setAddError("");
    setAddNotice("");
    // A top-level item can never be a Task, so the picker does not offer one;
    // the guard repeats the rule rather than trusting the control's options.
    const requested: unknown = quickAddType;
    const type: WorkItemType = isQuickAddType(requested) && requested !== "task" ? requested : DEFAULT_QUICK_ADD_TYPE;
    void api.createItem({ title: trimmed, type }).then(async () => {
      if (!isActive()) return;
      const added = await refreshBacklog(true);
      if (!isActive()) return;
      if (added) setAddNotice(`Added \u201C${trimmed}\u201D to the backlog.`);
      else setAddError(BACKLOG_ADD_ERROR);
    }).catch((caught: unknown) => {
      if (!isActive() || terminalAuthentication(caught)) return;
      setAddError(BACKLOG_ADD_ERROR);
    }).finally(() => {
      if (mountedRef.current && !terminalRef.current) setAdding(false);
    });
  }, [adding, api, isActive, quickAddType, refreshBacklog, terminalAuthentication]);

  return {
    items,
    groups,
    expanded,
    loading,
    error,
    status,
    busy,
    optimisticId: overlay === null ? null : overlay.id,
    moveAttempt,
    refusal,
    refuse,
    clearRefusal,
    adding,
    addError,
    addNotice,
    quickAddType,
    setQuickAddType,
    refresh: () => { void refreshBacklog(); },
    toggle,
    move,
    addItem,
  };
}

/**
 * Apply one move to the canonical list without asking the server, so the row
 * lands where the user put it immediately.
 *
 * `groupBacklog` sorts siblings by `(backlogPosition, id)`, so the overlay has
 * to rewrite positions rather than merely reorder the array: the destination
 * group is renumbered with the moved item spliced in at its anchor, and the
 * group it left is closed up behind it. Every other item keeps the position
 * the server gave it. Returns `null` when the intent cannot be expressed
 * locally, which leaves the canonical list on screen rather than a guess.
 */
export function optimisticOrder(items: readonly BacklogItem[], intent: BacklogMove): readonly BacklogItem[] | null {
  const moved = items.find((item) => item.id === intent.itemId);
  if (moved === undefined) return null;

  // An item's group key is its parent when that parent is present in this
  // backlog, and the top level otherwise — the same rule `groupBacklog` uses.
  const present = new Set(items.map((item) => item.id));
  const groupOf = (item: BacklogItem): number | null =>
    item.parentId !== null && item.parentId !== item.id && present.has(item.parentId) ? item.parentId : null;
  const destination = groupOf({ ...moved, parentId: intent.parentId });
  if (destination !== intent.parentId) return null;

  const positions = new Map<number, number>();
  const byPosition = (left: BacklogItem, right: BacklogItem): number =>
    left.backlogPosition - right.backlogPosition || left.id - right.id;
  const renumber = (order: readonly BacklogItem[]): void => {
    order.forEach((item, index) => positions.set(item.id, index));
  };

  const destinationSiblings = items
    .filter((item) => item.id !== moved.id && groupOf(item) === intent.parentId)
    .sort(byPosition);
  const anchor = intent.beforeId === null ? destinationSiblings.length : destinationSiblings.findIndex((item) => item.id === intent.beforeId);
  if (anchor === -1) return null;
  const nextDestination = [...destinationSiblings.slice(0, anchor), moved, ...destinationSiblings.slice(anchor)];

  // The group the item left needs its own positions closed up, or the gap it
  // left behind would keep a stale position that the server no longer has.
  if (moved.parentId !== intent.parentId) {
    renumber(items.filter((item) => item.id !== moved.id && groupOf(item) === groupOf(moved)).sort(byPosition));
  }
  renumber(nextDestination);

  return items.map((item) => {
    const position = positions.get(item.id);
    if (item.id === moved.id) return { ...moved, parentId: intent.parentId, backlogPosition: position ?? 0 };
    return position === undefined || position === item.backlogPosition ? item : { ...item, backlogPosition: position };
  });
}
