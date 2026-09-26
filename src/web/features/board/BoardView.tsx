import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { WorkStatus } from "../../../domain/types";
import { StatusColumn } from "./components";
import { useBoard } from "./hooks";
import { BOARD_STATUSES } from "./types";
import type { BoardFocusTarget, BoardViewProps } from "./types";

export function BoardView(props: BoardViewProps) {
  const board = useBoard(props);
  const boardRef = useRef<HTMLDivElement>(null);
  const acknowledgedFocusSequenceRef = useRef(0);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<WorkStatus | null>(null);

  const moveItem = useCallback((id: number, status: WorkStatus, focusTarget?: BoardFocusTarget): void => {
    board.moveItem(id, status, focusTarget);
  }, [board.moveItem]);

  useEffect(() => {
    const request = board.focusRequest;
    if (request === null || request.sequence === acknowledgedFocusSequenceRef.current) return;

    const control = boardRef.current?.querySelector<HTMLElement>(
      `[data-id="${request.id}"] [data-focus-target="${request.target}"]`,
    );
    if (control === null || control === undefined) return;

    if (request.force || document.activeElement !== control) control.focus();
    // Acknowledge each optimistic/final request locally. Later item refreshes retain
    // the request in state but cannot take focus again after it has been consumed.
    acknowledgedFocusSequenceRef.current = request.sequence;
  }, [board.focusRequest, board.items]);

  const displayedDraggingId = draggingId !== null && board.items.some((item) => item.id === draggingId)
    ? draggingId
    : null;
  const empty = !board.loading && board.items.length === 0;
  const boardStatus = board.loading
    ? "Loading board…"
    : board.error || board.notice || (empty ? "No work items yet. Add one in any column." : "");
  const statusIsPersistent = board.loading || (empty && board.error === "" && board.notice === "");

  return (
    <>
      <div class="page-header">
        <div>
          <h1>Board</h1>
          <p>Track work as it moves from idea to completion.</p>
        </div>
        <div class="keyboard-hint">Tip: use ← and → to move a focused item</div>
      </div>

      <div
        class={`board-status${statusIsPersistent ? " hint" : " sr-only"}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {boardStatus}
      </div>

      {board.error !== "" ? (
        <div class="error-banner" role="alert">
          {board.error} <button type="button" onClick={board.refresh}>Retry</button>
        </div>
      ) : null}

      <div class="board" ref={boardRef} aria-busy={board.loading}>
          {BOARD_STATUSES.map((status) => (
            <StatusColumn
              key={status}
              status={status}
              loading={board.loading}
              items={board.items.filter((item) => item.status === status)}
              movingItems={board.movingItems}
              quickAddBusy={board.quickAddBusy.has(status)}
              draggingId={displayedDraggingId}
              dropTarget={dropTarget === status}
              onMove={moveItem}
              onAdd={board.addItem}
              onDragStart={setDraggingId}
              onDragEnd={() => {
                setDraggingId(null);
                setDropTarget(null);
              }}
              onDropTarget={setDropTarget}
            />
          ))}
      </div>
    </>
  );
}
