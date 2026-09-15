import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { WorkStatus } from "../../../domain/types";
import * as apiModule from "../../api.js";
import { isTerminalAuthError } from "../../public-errors.js";
import { boardItemFromResponse, boardItemsFromResponse, isPositiveId, isWorkStatus } from "./data";
import { BOARD_COLUMN_LABELS } from "./types";
import type { BoardFocusRequest, BoardFocusTarget, BoardItem, BoardState, BoardViewProps } from "./types";

type ApiResponse<T> = { data: T };

interface BoardApi {
  listItems: (params: { limit: number }) => Promise<ApiResponse<unknown>>;
  createItem: (input: { title: string }) => Promise<ApiResponse<unknown>>;
  updateItem: (id: number, patch: { status: WorkStatus }) => Promise<ApiResponse<unknown>>;
}

interface MoveIntent {
  status: WorkStatus;
  focusTarget: BoardFocusTarget | undefined;
}

interface StatusQueue {
  running: boolean;
  queued: MoveIntent | null;
}

export const BOARD_LOAD_ERROR = "Could not load the board. Please try again.";
export const BOARD_ADD_ERROR = "Could not add the item. Please try again.";
export const BOARD_MOVE_ERROR = "Could not move the item. Its previous status was restored.";
export const BOARD_PARTIAL_ADD_ERROR = "The item was added, but moving it to the requested column could not be confirmed.";

const api = apiModule as BoardApi;

export function useBoard({ refreshGeneration, onAuthenticationFailure }: BoardViewProps): BoardState {
  const mountedRef = useRef(true);
  const terminalRef = useRef(false);
  const authFailureRef = useRef(onAuthenticationFailure);
  const fetchGenerationRef = useRef(0);
  const canonicalRef = useRef<readonly BoardItem[]>([]);
  const overlaysRef = useRef(new Map<number, WorkStatus>());
  const queuesRef = useRef(new Map<number, StatusQueue>());
  const quickAddRef = useRef(new Set<WorkStatus>());
  const focusSequenceRef = useRef(0);
  const loadedRef = useRef(false);

  const [canonical, setCanonical] = useState<readonly BoardItem[]>([]);
  const [overlays, setOverlays] = useState<ReadonlyMap<number, WorkStatus>>(new Map());
  const [movingItems, setMovingItems] = useState<ReadonlySet<number>>(new Set());
  const [quickAddBusy, setQuickAddBusy] = useState<ReadonlySet<WorkStatus>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [focusRequest, setFocusRequest] = useState<BoardFocusRequest | null>(null);

  authFailureRef.current = onAuthenticationFailure;

  const isActive = useCallback((): boolean => mountedRef.current && !terminalRef.current, []);

  const setCanonicalItems = useCallback((items: readonly BoardItem[]): void => {
    canonicalRef.current = items;
    setCanonical(items);
  }, []);

  const setOverlay = useCallback((id: number, status: WorkStatus | null): void => {
    const next = new Map(overlaysRef.current);
    if (status === null) next.delete(id);
    else next.set(id, status);
    overlaysRef.current = next;
    setOverlays(next);
  }, []);

  const publishMovingItems = useCallback((): void => {
    setMovingItems(new Set(queuesRef.current.keys()));
  }, []);

  const requestFocus = useCallback((id: number, target: BoardFocusTarget | undefined, force: boolean): void => {
    if (target === undefined) return;
    setFocusRequest({ id, target, force, sequence: ++focusSequenceRef.current });
  }, []);

  const terminalAuthentication = useCallback((caught: unknown): boolean => {
    if (!isTerminalAuthError(caught)) return false;
    if (!terminalRef.current) {
      terminalRef.current = true;
      fetchGenerationRef.current += 1;
      for (const queue of queuesRef.current.values()) queue.queued = null;
      queuesRef.current.clear();
      quickAddRef.current.clear();
      setMovingItems(new Set());
      setQuickAddBusy(new Set());
      authFailureRef.current();
    }
    return true;
  }, []);

  const refreshBoard = useCallback(async (preserveMessage = false): Promise<boolean> => {
    if (!isActive()) return false;
    const generation = ++fetchGenerationRef.current;
    if (!loadedRef.current) setLoading(true);
    try {
      const response = await api.listItems({ limit: 100 });
      if (!isActive() || generation !== fetchGenerationRef.current) return false;
      const items = boardItemsFromResponse(response);
      if (items === null) {
        loadedRef.current = true;
        setLoading(false);
        setError(BOARD_LOAD_ERROR);
        setNotice("");
        return false;
      }
      setCanonicalItems(items);
      loadedRef.current = true;
      setLoading(false);
      if (!preserveMessage) {
        setError("");
        setNotice("");
      }
      return true;
    } catch (caught: unknown) {
      if (!isActive() || generation !== fetchGenerationRef.current) return false;
      if (terminalAuthentication(caught)) return false;
      loadedRef.current = true;
      setLoading(false);
      setError(BOARD_LOAD_ERROR);
      setNotice("");
      return false;
    }
  }, [isActive, setCanonicalItems, terminalAuthentication]);

  const updateAcceptedItem = useCallback((id: number, status: WorkStatus, response: unknown): boolean => {
    const returned = boardItemFromResponse(response);
    if (returned === null || returned.id !== id || returned.status !== status) return false;
    setCanonicalItems(canonicalRef.current.map((item) => item.id === id ? returned : item));
    return true;
  }, [setCanonicalItems]);

  const drainStatusQueue = useCallback(async (id: number, queue: StatusQueue): Promise<void> => {
    if (queue.running) return;
    queue.running = true;
    try {
      while (isActive() && queue.queued !== null) {
        const intent = queue.queued;
        queue.queued = null;
        let accepted = false;
        try {
          const response = await api.updateItem(id, { status: intent.status });
          if (!isActive()) return;
          accepted = updateAcceptedItem(id, intent.status, response);
          if (!accepted) throw new Error("Invalid update response");
          setError("");
          setNotice(`Moved item to ${BOARD_COLUMN_LABELS[intent.status]}.`);
          requestFocus(id, intent.focusTarget, true);
          await refreshBoard(true);
        } catch (caught: unknown) {
          if (!isActive() || terminalAuthentication(caught)) return;
          if (queue.queued === null) setOverlay(id, null);
          setNotice("");
          setError(BOARD_MOVE_ERROR);
          requestFocus(id, intent.focusTarget, true);
          await refreshBoard(true);
          if (isActive()) {
            setNotice("");
            setError(BOARD_MOVE_ERROR);
          }
        }
        if (!isActive()) return;
        if (queue.queued === null) setOverlay(id, null);
      }
    } finally {
      queue.running = false;
      if (queue.queued === null) {
        queuesRef.current.delete(id);
        if (mountedRef.current && !terminalRef.current) publishMovingItems();
      }
    }
  }, [isActive, publishMovingItems, refreshBoard, requestFocus, setOverlay, terminalAuthentication, updateAcceptedItem]);

  const moveItem = useCallback((id: number, status: WorkStatus, focusTarget?: BoardFocusTarget): void => {
    if (!isActive() || !isPositiveId(id) || !isWorkStatus(status)) return;
    const item = canonicalRef.current.find((candidate) => candidate.id === id);
    if (item === undefined) return;
    const currentStatus = overlaysRef.current.get(id) ?? item.status;
    if (currentStatus === status) return;

    setError("");
    setNotice(`Moving item to ${BOARD_COLUMN_LABELS[status]}…`);
    setOverlay(id, status);
    requestFocus(id, focusTarget, false);

    let queue = queuesRef.current.get(id);
    if (queue === undefined) {
      queue = { running: false, queued: null };
      queuesRef.current.set(id, queue);
      publishMovingItems();
    }
    queue.queued = { status, focusTarget };
    void drainStatusQueue(id, queue);
  }, [drainStatusQueue, isActive, publishMovingItems, requestFocus, setOverlay]);

  const setQuickBusy = useCallback((status: WorkStatus, busy: boolean): void => {
    const next = new Set(quickAddRef.current);
    if (busy) next.add(status);
    else next.delete(status);
    quickAddRef.current = next;
    setQuickAddBusy(next);
  }, []);

  const addItem = useCallback(async (status: WorkStatus, title: string): Promise<boolean> => {
    const trimmed = title.trim();
    if (!isActive() || !isWorkStatus(status) || trimmed === "" || quickAddRef.current.has(status)) return false;
    setError("");
    setNotice("Adding item…");
    setQuickBusy(status, true);
    let created: BoardItem | null = null;
    try {
      const createResponse = await api.createItem({ title: trimmed });
      if (!isActive()) return false;
      created = boardItemFromResponse(createResponse);
      if (created === null) throw new Error("Invalid create response");
      setCanonicalItems([...canonicalRef.current.filter((item) => item.id !== created!.id), created]);

      if (status !== "todo") {
        try {
          const updateResponse = await api.updateItem(created.id, { status });
          if (!isActive()) return true;
          if (!updateAcceptedItem(created.id, status, updateResponse)) throw new Error("Invalid update response");
        } catch (caught: unknown) {
          if (!isActive()) return true;
          setNotice("");
          setError(BOARD_PARTIAL_ADD_ERROR);
          if (!terminalAuthentication(caught)) {
            await refreshBoard(true);
            if (isActive()) setError(BOARD_PARTIAL_ADD_ERROR);
          }
          return true;
        }
      }

      setNotice(`Added item to ${BOARD_COLUMN_LABELS[status]}.`);
      void refreshBoard(true);
      return true;
    } catch (caught: unknown) {
      if (!isActive() || terminalAuthentication(caught)) return false;
      setNotice("");
      setError(BOARD_ADD_ERROR);
      await refreshBoard(true);
      if (isActive()) setError(BOARD_ADD_ERROR);
      return false;
    } finally {
      if (mountedRef.current && !terminalRef.current) setQuickBusy(status, false);
    }
  }, [isActive, refreshBoard, setCanonicalItems, setQuickBusy, terminalAuthentication, updateAcceptedItem]);

  useEffect(() => {
    void refreshBoard();
  }, [refreshBoard, refreshGeneration]);

  useEffect(() => () => {
    mountedRef.current = false;
    fetchGenerationRef.current += 1;
    for (const queue of queuesRef.current.values()) queue.queued = null;
    queuesRef.current.clear();
    quickAddRef.current.clear();
  }, []);

  const items = useMemo(() => canonical.map((item) => {
    const status = overlays.get(item.id);
    return status === undefined || status === item.status ? item : { ...item, status };
  }), [canonical, overlays]);

  return {
    items,
    loading,
    error,
    notice,
    focusRequest,
    movingItems,
    quickAddBusy,
    refresh: () => { void refreshBoard(); },
    moveItem,
    addItem,
  };
}
