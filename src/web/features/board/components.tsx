import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { WorkStatus } from "../../../domain/types";
import { clampedStatusTarget, isWorkStatus, normalizeCommentCount, validateInternalDragId } from "./data";
import { BOARD_COLUMN_LABELS, BOARD_STATUSES } from "./types";
import type { BoardFocusTarget, BoardItem } from "./types";

function initials(name: string): string {
  return name
    .split(/[\s_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function priorityClass(priority: number): string {
  return ["p0", "p1", "p2", "p3"][priority] ?? "p2";
}

interface WorkItemCardProps {
  item: BoardItem;
  onMove: (id: number, status: WorkStatus, focusTarget?: BoardFocusTarget) => void;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
  dragging: boolean;
  moving: boolean;
}

export function WorkItemCard({ item, onMove, onDragStart, onDragEnd, dragging, moving }: WorkItemCardProps) {
  const count = normalizeCommentCount(item.commentCount) ?? 0;
  const commentLabel = count === 1 ? "1 comment" : `${count} comments`;
  const assigneeLabel = item.assignee === null
    ? "Unassigned"
    : `Assigned to ${item.assignee.name}, ${item.assignee.kind}`;
  const metadataId = `board-item-${item.id}-metadata`;

  const onTitleKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLAnchorElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const nextStatus = clampedStatusTarget(item.status, event.key === "ArrowLeft" ? -1 : 1);
    if (nextStatus === item.status) return;
    event.preventDefault();
    onMove(item.id, nextStatus, "title");
  };

  return (
    <article
      class={`board-card${dragging ? " dragging" : ""}`}
      draggable
      data-id={String(item.id)}
      data-status={item.status}
      aria-busy={moving}
      onDragStart={(event) => {
        event.dataTransfer?.setData("text/plain", String(item.id));
        if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
        onDragStart(item.id);
      }}
      onDragEnd={onDragEnd}
    >
      <div class="board-card-top">
        <span class={`chip ${priorityClass(item.priority)}`}>P{item.priority}</span>
        {item.labels.map((label) => <span class="chip label-chip" key={label.id}>{label.name}</span>)}
      </div>
      <a
        class="board-card-title"
        href={`#/item/${item.id}`}
        aria-describedby={metadataId}
        data-focus-target="title"
        onKeyDown={onTitleKeyDown}
      >
        {item.title}
      </a>
      <span class="sr-only" id={metadataId}>{commentLabel}. {assigneeLabel}.</span>
      <div class="board-card-bottom">
        <span class="board-card-refs">
          <span class="muted">#{item.id}</span>
          <span class={`chip comment-chip${count === 0 ? " empty" : ""}`} aria-hidden="true">
            {count === 0 ? "" : count}
          </span>
        </span>
        <span class="board-card-people">
          {item.assignee?.kind === "agent" ? <span class="chip agent-chip" aria-hidden="true">agent</span> : null}
          {item.assignee !== null ? (
            <span
              class={`avatar avatar-${item.assignee.kind}`}
              title={`${item.assignee.name} (${item.assignee.kind})`}
              aria-hidden="true"
            >
              {initials(item.assignee.name)}
            </span>
          ) : null}
        </span>
      </div>
      <select
        aria-label={`Move #${item.id} to status`}
        value={item.status}
        data-focus-target="status"
        onChange={(event) => {
          const status: unknown = event.currentTarget.value;
          if (isWorkStatus(status) && status !== item.status) onMove(item.id, status, "status");
        }}
      >
        {BOARD_STATUSES.map((status) => <option value={status} key={status}>{BOARD_COLUMN_LABELS[status]}</option>)}
      </select>
    </article>
  );
}

interface QuickAddProps {
  status: WorkStatus;
  busy: boolean;
  onAdd: (status: WorkStatus, title: string) => Promise<boolean>;
}

export function QuickAdd({ status, busy, onAdd }: QuickAddProps) {
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (!busy && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      inputRef.current?.focus();
    }
  }, [busy]);

  const submit = async (event: JSX.TargetedSubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || title.trim() === "") return;
    restoreFocusRef.current = true;
    if (await onAdd(status, title)) setTitle("");
  };

  const label = `Add item to ${BOARD_COLUMN_LABELS[status]}`;
  return (
    <form class="quick-add" aria-busy={busy} onSubmit={submit}>
      <input
        ref={inputRef}
        type="text"
        name={`quick-add-${status}`}
        title={label}
        value={title}
        readOnly={busy}
        autoComplete="off"
        maxLength={256}
        placeholder={busy ? "Adding…" : "Add item…"}
        aria-label={label}
        onInput={(event) => setTitle(event.currentTarget.value)}
      />
      <button type="submit" disabled={busy || title.trim() === ""}>{busy ? "Adding…" : "Add"}</button>
    </form>
  );
}

interface StatusColumnProps {
  status: WorkStatus;
  items: readonly BoardItem[];
  movingItems: ReadonlySet<number>;
  quickAddBusy: boolean;
  draggingId: number | null;
  dropTarget: boolean;
  onMove: (id: number, status: WorkStatus, focusTarget?: BoardFocusTarget) => void;
  onAdd: (status: WorkStatus, title: string) => Promise<boolean>;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
  onDropTarget: (status: WorkStatus | null) => void;
}

export function StatusColumn(props: StatusColumnProps) {
  const { status, items } = props;
  const columnId = `board-column-${status}`;
  const titleId = `${columnId}-title`;
  const itemCount = items.length === 1 ? "1 item" : `${items.length} items`;

  return (
    <section
      id={columnId}
      aria-labelledby={titleId}
      class={`board-column${props.dropTarget ? " drop-target" : ""}`}
      data-status={status}
      onDragOver={(event) => {
        if (props.draggingId === null) return;
        event.preventDefault();
        if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
        props.onDropTarget(status);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onDropTarget(null);
      }}
      onDrop={(event) => {
        const id = validateInternalDragId(event.dataTransfer?.getData("text/plain"), props.draggingId);
        props.onDropTarget(null);
        if (id === null) return;
        event.preventDefault();
        props.onMove(id, status);
      }}
    >
      <h2 class="board-column-title" id={titleId}>
        {BOARD_COLUMN_LABELS[status]}
        <span class="count" aria-hidden="true">{items.length}</span>
        <span class="sr-only">{itemCount}</span>
      </h2>
      <div class="board-cards" data-status={status}>
        {items.length === 0 ? <div class="hint">No items</div> : items.map((item) => (
          <WorkItemCard
            key={item.id}
            item={item}
            onMove={props.onMove}
            onDragStart={props.onDragStart}
            onDragEnd={props.onDragEnd}
            dragging={props.draggingId === item.id}
            moving={props.movingItems.has(item.id)}
          />
        ))}
      </div>
      <QuickAdd status={status} busy={props.quickAddBusy} onAdd={props.onAdd} />
    </section>
  );
}
