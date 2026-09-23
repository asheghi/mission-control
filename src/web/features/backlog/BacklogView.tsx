import { useCallback, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { WORK_ITEM_TYPE_LABELS } from "../../../domain/types";
import type { WorkItemType } from "../../../domain/types";
import * as api from "../../api.js";
import { useBacklog } from "./hooks";
import type { BacklogApi } from "./hooks";
import {
  BACKLOG_DIRECTION_MARKS,
  BACKLOG_MOVE_DIRECTIONS,
  backlogDropTarget,
  backlogItemLabel,
  backlogMoveDirectionReason,
  backlogMoveActions,
  backlogMoveTargets,
  backlogLevels,
  displayLevel,
  dropRefusalMessage,
  isDroppableRow,
} from "./moves";
import { BACKLOG_STATUS_LABELS, BACKLOG_TOP_LEVEL_TYPES } from "./types";
import type { BacklogGroup, BacklogItem, BacklogMoveAction, BacklogTargets, BacklogViewProps } from "./types";

/** Item, Type, Status, Priority, Assignee, Labels, Move. */
const COLUMN_COUNT = 7;

/**
 * The backlog endpoints, narrowed from the shared client. The view owns the one
 * API import for this feature; the hook takes these as arguments so its state
 * logic stays independent of how the requests are actually made.
 */
const backlogApi: BacklogApi = {
  listBacklog: () => api.listBacklog(),
  createItem: (input) => api.createItem(input),
  reorderItem: (id, input) => api.reorderItem(id, input),
};

function subTaskCount(count: number): string {
  return `${count} ${count === 1 ? "sub-task" : "sub-tasks"}`;
}

interface DragState {
  readonly itemId: number;
  /** Row the pointer is over, and whether it would nest inside it. */
  readonly rowId: number | null;
  readonly nested: boolean;
}

interface BacklogRowsProps {
  readonly node: BacklogGroup;
  readonly level: number;
  readonly expanded: ReadonlySet<number>;
  readonly targets: BacklogTargets;
  readonly dragging: DragState | null;
  readonly busy: boolean;
  readonly optimisticId: number | null;
  readonly onToggle: (id: number) => void;
  readonly onMove: (action: BacklogMoveAction) => void;
  /** Reports a move the view refuses locally, so the reason is announced. */
  readonly onRefuse: (itemId: number, message: string) => void;
  readonly onDragStateChange: (state: DragState | null) => void;
}

/**
 * The keyboard controls for one row. They are plain buttons rather than hidden
 * key bindings so they are discoverable, reachable by Tab, and announced with
 * the row they act on — ordering is never pointer-only.
 *
 * All four directions are rendered for every row, in the same order. A row with
 * fewer legal moves therefore still offers the same four tab stops, and a
 * direction it cannot take is `aria-disabled` with the reason in its label
 * rather than a button that quietly disappears. `:disabled` is reserved for the
 * transient in-flight state, which is a different thing.
 */
function RowMoveControls({ item, actions, targets, busy, onMove }: {
  readonly item: BacklogItem;
  readonly actions: readonly BacklogMoveAction[];
  readonly targets: BacklogTargets;
  readonly busy: boolean;
  readonly onMove: (action: BacklogMoveAction) => void;
}) {
  return (
    <div class="backlog-move-controls">
      {BACKLOG_MOVE_DIRECTIONS.map((direction) => {
        const available = actions.find((action) => action.id === direction);
        const label = available?.label ?? backlogMoveDirectionReason(targets, item, direction);
        return (
          <button
            class="backlog-move-button"
            type="button"
            key={direction}
            aria-label={label}
            title={label}
            aria-disabled={busy || available === undefined}
            onClick={() => { if (!busy && available !== undefined) onMove(available); }}
          >
            <span aria-hidden="true">{BACKLOG_DIRECTION_MARKS[direction]}</span>
          </button>
        );
      })}
    </div>
  );
}

function BacklogRows({
  node,
  level,
  expanded,
  targets,
  dragging,
  busy,
  optimisticId,
  onToggle,
  onMove,
  onRefuse,
  onDragStateChange,
}: BacklogRowsProps) {
  const { item, children } = node;
  const hasChildren = children.length > 0;
  const isExpanded = hasChildren && expanded.has(item.id);
  const actions = backlogMoveActions(targets, item);
  const depth = displayLevel(level);
  const isDragging = dragging?.itemId === item.id;
  const isDropRow = dragging !== null && dragging.rowId === item.id && isDroppableRow(targets, dragging.itemId, item.id);
  const rowRef = useRef<HTMLTableRowElement>(null);

  /** Decide, from the pointer's position in the row, whether to nest or insert. */
  const dropMode = useCallback((event: JSX.TargetedDragEvent<HTMLTableRowElement>): boolean => {
    const box = rowRef.current?.getBoundingClientRect();
    if (box === undefined || box.height === 0) return false;
    // The lower part of the row means "into this item", the upper part means
    // "before this item" — one row, two zones, as in a file tree.
    return event.clientY > box.top + box.height / 2;
  }, []);

  return (
    <>
      <tr
        ref={rowRef}
        class={`${level > 1 ? "backlog-child-row" : ""}${isDragging ? " backlog-dragging" : ""}${isDropRow ? (dragging.nested ? " backdrop-into" : " backdrop-before") : ""}${optimisticId === item.id ? " backlog-optimistic" : ""}`.trim()}
        aria-level={level}
        data-row-id={String(item.id)}
        onDragOver={(event) => {
          if (dragging === null || !isDroppableRow(targets, dragging.itemId, item.id)) return;
          event.preventDefault();
          if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
          const nested = dropMode(event);
          if (dragging.rowId === item.id && dragging.nested === nested) return;
          onDragStateChange({ itemId: dragging.itemId, rowId: item.id, nested });
        }}
        onDragLeave={() => {
          if (dragging?.rowId === item.id) onDragStateChange({ itemId: dragging.itemId, rowId: null, nested: false });
        }}
        onDrop={(event) => {
          if (dragging === null) return;
          const sourceId = dragging.itemId;
          const nested = dropMode(event);
          event.preventDefault();
          onDragStateChange(null);
          const source = targets.byId.get(sourceId);
          const drop = backlogDropTarget(targets, sourceId, item.id, nested);
          if (source === undefined) return;
          if (drop === null) {
            // A row cannot be dropped onto itself or into its own subtree. The
            // drag simply ends, and saying so beats a row that snaps back with
            // no explanation.
            onRefuse(sourceId, `Cannot drop ${backlogItemLabel(source)} onto ${backlogItemLabel(item)}: an item cannot be moved inside itself.`);
            return;
          }
          const action = backlogInsertAction(targets, source, drop.parentId, drop.beforeId);
          if (action === null) {
            // The drop was legal to attempt but the row may not go there — most
            // importantly a Task dropped at the top level. The reason comes from
            // one place, so the pointer and keyboard paths cannot drift into
            // telling the user different things.
            onRefuse(source.id, dropRefusalMessage(source, drop.parentId));
            return;
          }
          onMove(action);
        }}
      >
        <td class="backlog-item-cell" data-label="Item">
          <div class="backlog-item-title">
            {Array.from({ length: depth - 1 }, (_, index) => <span class="backlog-indent" key={index} aria-hidden="true" />)}
            {/* The handle is a focusable, labelled control rather than a
                decorative grip: dragging is one way to move a row, and the
                buttons beside it are the other. */}
            <span
              class="backlog-drag-handle"
              role="button"
              tabIndex={0}
              draggable
              aria-label={`Drag ${backlogItemLabel(item)} to reorder it`}
              title={`Drag ${backlogItemLabel(item)}, or use the move buttons, to reorder it`}
              onDragStart={(event) => {
                event.dataTransfer?.setData("text/plain", String(item.id));
                if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
                onDragStateChange({ itemId: item.id, rowId: null, nested: false });
              }}
              onDragEnd={() => onDragStateChange(null)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                // Keyboard users get the same gesture through the buttons; the
                // handle itself only has to exist as a labelled target.
                rowRef.current?.querySelector<HTMLButtonElement>(".backlog-move-button:not(:disabled)")?.focus();
              }}
            >
              <span aria-hidden="true">{"\u22ee\u22ee"}</span>
            </span>
            {hasChildren ? (
              <button
                class="backlog-toggle"
                type="button"
                aria-expanded={isExpanded}
                /* Points at the region the toggle actually controls, so the
                   disclosure is announced as a relationship and not just a
                   state. The region is rendered only while expanded, which is
                   exactly when it exists to be controlled. */
                aria-controls={hasChildren ? `backlog-children-${item.id}` : undefined}
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
        <td data-label="Type"><span class="chip backlog-type-chip">{WORK_ITEM_TYPE_LABELS[item.type]}</span></td>
        <td data-label="Status"><span class={`chip status-chip status-${item.status}`}>{BACKLOG_STATUS_LABELS[item.status]}</span></td>
        <td data-label="Priority"><span class={`chip p${item.priority}`}>P{item.priority}</span></td>
        <td data-label="Assignee">{item.assignee === null ? <span class="muted">Unassigned</span> : <span>{item.assignee.name}{item.assignee.kind === "agent" ? <span class="muted"> (agent)</span> : null}</span>}</td>
        <td data-label="Labels"><div class="backlog-labels">{item.labels.map((label) => <span class="chip label-chip" key={label.id}>{label.name}</span>)}</div></td>
        <td data-label="Move">
          <RowMoveControls item={item} actions={actions} targets={targets} busy={busy} onMove={onMove} />
          {actions.some((action) => action.id === "root") ? null : <span class="sr-only">This item cannot be moved to the top level.</span>}
        </td>
      </tr>
      {/* One wrapper element per expanded parent, so the toggle's aria-controls
          resolves to a real node. A <tbody> can hold it without disturbing the
          table layout. */}
      {isExpanded ? (
        <tbody id={`backlog-children-${item.id}`}>
          {children.map((child) => (
            <BacklogRows
              key={child.item.id}
              node={child}
              level={level + 1}
              expanded={expanded}
              targets={targets}
              dragging={dragging}
              busy={busy}
              optimisticId={optimisticId}
              onToggle={onToggle}
              onMove={onMove}
              onRefuse={onRefuse}
              onDragStateChange={onDragStateChange}
            />
          ))}
        </tbody>
      ) : null}
    </>
  );
}

/** Build a validated move for a resolved drop, reusing the keyboard path's rules. */
function backlogInsertAction(
  targets: BacklogTargets,
  item: BacklogItem,
  parentId: number | null,
  beforeId: number | null,
): BacklogMoveAction | null {
  return backlogMoveActions(targets, item).find((action) => action.move.parentId === parentId && action.move.beforeId === beforeId)
    ?? describeDrop(targets, item, parentId, beforeId);
}

/** Wording for a drop that no keyboard action happens to describe. */
function describeDrop(
  targets: BacklogTargets,
  item: BacklogItem,
  parentId: number | null,
  beforeId: number | null,
): BacklogMoveAction | null {
  if (item.type === "task" && parentId === null) return null;
  const anchor = beforeId === null ? null : targets.byId.get(beforeId) ?? null;
  if (beforeId !== null && anchor === null) return null;
  const parent = parentId === null ? null : targets.byId.get(parentId) ?? null;
  if (parentId !== null && parent === null) return null;
  return {
    id: "drop",
    label: anchor === null
      ? `Moved ${backlogItemLabel(item)} into ${parent === null ? "the top level" : backlogItemLabel(parent)}.`
      : `Moved ${backlogItemLabel(item)} before ${backlogItemLabel(anchor)}.`,
    move: {
      itemId: item.id,
      parentId,
      beforeId,
      announcement: anchor === null
        ? `Moved ${backlogItemLabel(item)} to the end of ${parent === null ? "the top level" : `the children of ${backlogItemLabel(parent)}`}.`
        : `Moved ${backlogItemLabel(item)} before ${backlogItemLabel(anchor)}.`,
    },
    focusRowId: item.id,
  };
}

export function BacklogView(props: BacklogViewProps) {
  const backlog = useBacklog(backlogApi, props);
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState<DragState | null>(null);

  // Rows the user can currently see: a collapsed parent's children are still
  // loaded, but they are not rows on screen, so they are not drop or step
  // targets either.
  const visible = useMemo(() => {
    const ids = new Set<number>();
    const walk = (nodes: readonly BacklogGroup[]): void => {
      for (const node of nodes) {
        ids.add(node.item.id);
        if (node.children.length > 0 && backlog.expanded.has(node.item.id)) walk(node.children);
      }
    };
    walk(backlog.groups);
    return ids;
  }, [backlog.groups, backlog.expanded]);

  const targets = useMemo(() => backlogMoveTargets(backlog.groups, visible), [backlog.groups, visible]);
  const levels = useMemo(() => backlogLevels(backlog.groups), [backlog.groups]);

  const move = useCallback((action: BacklogMoveAction): void => {
    setDragging(null);
    backlog.move(action.move);
  }, [backlog]);

  // A refusal is announced through the same live region as a success, so the
  // user hears the outcome of every move from one place.
  const liveMessage = backlog.moveAttempt !== null
    ? backlog.moveAttempt.message
    : backlog.loading
      ? "Loading backlog\u2026"
      : backlog.error !== ""
        ? backlog.error
        : backlog.status !== "" ? backlog.status : `${backlog.items.length} backlog items loaded`;

  return (
    <div class="backlog-view">
      <div class="page-header">
        <div>
          <h1>Backlog</h1>
          <p>Shape upcoming work and break it into manageable sub-tasks.</p>
        </div>
        <div class="keyboard-hint">Tip: drag a row, or use its move buttons, to reorder it</div>
      </div>

      <div class="backlog-status sr-only" role="status" aria-live="polite" aria-atomic="true">{liveMessage}</div>
      {backlog.moveAttempt === null ? null : (
        // `role="alert"` so a refused move is not merely polite: the row stayed
        // put and the user needs to know why without hunting for it. It is
        // dismissible because a refusal is a transient explanation, not a state
        // of the board.
        <div class="notice-banner backlog-refusal" role="alert">
          {backlog.moveAttempt.message}
          <button type="button" onClick={backlog.clearRefusal}>Dismiss</button>
        </div>
      )}
      {backlog.error === "" ? null : (
        <div class="error-banner">
          {backlog.error} <button type="button" onClick={backlog.refresh}>Retry</button>
        </div>
      )}

      <form
        class="backlog-add card"
        aria-busy={backlog.adding}
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim() === "") return;
          backlog.addItem(draft);
          setDraft("");
        }}
      >
        <label for="backlog-add-title">Add backlog item</label>
        <div>
          <select
            id="backlog-add-type"
            aria-label="Work item type for the new backlog item"
            value={backlog.quickAddType}
            disabled={backlog.adding}
            onChange={(event) => {
              const next: unknown = event.currentTarget.value;
              if (typeof next === "string" && (BACKLOG_TOP_LEVEL_TYPES as readonly string[]).includes(next)) {
                backlog.setQuickAddType(next as WorkItemType);
              }
            }}
          >
            {BACKLOG_TOP_LEVEL_TYPES.map((type) => (
              <option value={type} key={type}>{WORK_ITEM_TYPE_LABELS[type]}</option>
            ))}
          </select>
          <input
            id="backlog-add-title"
            name="title"
            autoComplete="off"
            value={draft}
            maxLength={256}
            placeholder="Add an upcoming work item…"
            disabled={backlog.adding}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
          <button class="primary" type="submit" aria-label="Add backlog item" disabled={backlog.adding || draft.trim() === ""}>
            {backlog.adding ? "Adding\u2026" : "Add item"}
          </button>
        </div>
        {/* A Task needs a parent, so it is not offered here: the picker only
            lists the types that are valid at the top level. */}
        <p class="backlog-add-hint muted">Tasks are created inside an existing item, so they are not offered at the top level.</p>
        {backlog.addError === "" ? null : <p class="error" role="alert">{backlog.addError}</p>}
        {backlog.addNotice === "" ? null : <p class="backlog-add-notice muted" role="status">{backlog.addNotice}</p>}
      </form>

      <div
        class="backlog-table-scroller"
        tabIndex={0}
        role="region"
        aria-label="Backlog items table"
        aria-busy={backlog.busy || backlog.loading}
      >
        <table class="backlog-table">
          <caption class="sr-only">Backlog items, with sub-tasks nested under their parent</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Priority</th>
              <th scope="col">Assignee</th>
              <th scope="col">Labels</th>
              <th scope="col">Move</th>
            </tr>
          </thead>
          <tbody>
            {backlog.groups.map((group) => (
              <BacklogRows
                key={group.item.id}
                node={group}
                level={levels.get(group.item.id) ?? 1}
                expanded={backlog.expanded}
                targets={targets}
                dragging={dragging}
                busy={backlog.busy}
                optimisticId={backlog.optimisticId}
                onToggle={backlog.toggle}
                onMove={move}
                onRefuse={backlog.refuse}
                onDragStateChange={setDragging}
              />
            ))}
            {backlog.loading && backlog.items.length === 0 ? (
              <tr class="backlog-empty-row"><td colSpan={COLUMN_COUNT}><div class="empty-state"><strong>Loading backlog…</strong><span>Preparing the current view.</span></div></td></tr>
            ) : null}
            {!backlog.loading && backlog.groups.length === 0 ? (
              <tr class="backlog-empty-row"><td colSpan={COLUMN_COUNT}><div class="empty-state"><strong>No backlog items</strong><span>Add an item when you are ready to plan what comes next.</span></div></td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p class="backlog-root-note muted">
        Tasks always live inside a parent item. Dropping a Task at the top level is refused, and the reason is announced.
      </p>
    </div>
  );
}
