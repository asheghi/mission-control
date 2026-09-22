import type { ParticipantKind, Priority, WorkItemType, WorkStatus } from "../../../domain/types";
import type { ViewComponentProps } from "../../shell/types";

// Statuses read exactly as they do on the board and in the list, so the same
// item never appears under two different names in one product.
export const BACKLOG_STATUS_LABELS: Readonly<Record<WorkStatus, string>> = {
  todo: "To do",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
};

/** The statuses a backlog row can carry; `done` items leave the backlog. */
export const BACKLOG_STATUSES: readonly WorkStatus[] = ["todo", "doing", "blocked"];

/** Work-item types a top-level quick-add may create, in picker order. */
export const BACKLOG_TOP_LEVEL_TYPES: readonly WorkItemType[] = ["user_story", "feature", "bug"];

export interface BacklogItem {
  readonly id: number;
  readonly title: string;
  readonly type: WorkItemType;
  readonly status: WorkStatus;
  readonly priority: Priority;
  readonly parentId: number | null;
  readonly backlogPosition: number;
  readonly assignee: { readonly id: number; readonly name: string; readonly kind: ParticipantKind } | null;
  readonly labels: readonly { readonly id: number; readonly name: string }[];
}

export interface BacklogGroup {
  readonly item: BacklogItem;
  readonly children: readonly BacklogGroup[];
}

export interface BacklogViewProps extends ViewComponentProps {}

/**
 * Where one row sits among its siblings, plus the shape of the tree those
 * siblings live in. Flattening the groups into this list is what makes every
 * move expressible as a plain before/after target instead of a tree walk.
 */
export interface BacklogTargets {
  /** Every item in render order, by id. */
  readonly byId: ReadonlyMap<number, BacklogItem>;
  /** Every rendered item, in render order (roots first, children after them). */
  readonly rows: readonly BacklogItem[];
  /** Position of each item inside its own sibling group. */
  readonly siblingIndex: ReadonlyMap<number, number>;
  /** Sibling collection each id belongs to; parents that are missing are roots. */
  readonly siblings: ReadonlyMap<number, readonly BacklogItem[]>;
  /** Ids of every item that has at least one child. */
  readonly parents: ReadonlySet<number>;
  /** Depth-first render order of the ids in `rows`. */
  readonly order: readonly number[];
  /** Tree depth of every item, before the display cap is applied. */
  readonly levels: ReadonlyMap<number, number>;
}

/** A request that survived validation: exactly what `reorderItem` accepts. */
export interface BacklogMove {
  readonly itemId: number;
  readonly parentId: number | null;
  readonly beforeId: number | null;
  /** Written into the live region once the server accepts the move. */
  readonly announcement: string;
}

/**
 * Why a row was drawn: `tree` rows are the item's real children, while
 * `orphan` rows are items whose parent is missing, cyclic, itself, or simply
 * not part of this backlog, and which are therefore shown at the top level.
 */
export type BacklogRowPlacement = "tree" | "orphan";

/** A rejected attempt, with the wording the live region announces. */
export interface BacklogMoveAttempt {
  readonly moveId: number;
  readonly message: string;
  /** Focus to restore after a refusal, so the row keeps the keyboard. */
  readonly focusRowId: number | null;
}

export interface BacklogState {
  readonly items: readonly BacklogItem[];
  readonly groups: readonly BacklogGroup[];
  readonly expanded: ReadonlySet<number>;
  readonly loading: boolean;
  readonly error: string;
  readonly status: string;
  /** True while any request that changes the backlog is in flight. */
  readonly busy: boolean;
  /** Row whose pending optimistic position is being displayed, if any. */
  readonly optimisticId: number | null;
  readonly moveAttempt: BacklogMoveAttempt | null;
  /**
   * A move the view refused before issuing a request — a Task dropped at the
   * top level, or a second move while one is still being saved. It is not a
   * failed write, so it is kept apart from `moveAttempt`: nothing was sent and
   * nothing needs rolling back, but the user still has to be told why the row
   * did not move, through the same live region and banner.
   */
  readonly refusal: string;
  readonly refuse: (itemId: number, message: string) => void;
  readonly clearRefusal: () => void;
  readonly adding: boolean;
  readonly addError: string;
  readonly addNotice: string;
  readonly quickAddType: WorkItemType;
  readonly setQuickAddType: (type: WorkItemType) => void;
  readonly refresh: () => void;
  readonly toggle: (id: number) => void;
  readonly move: (move: BacklogMove) => void;
  readonly addItem: (title: string) => void;
}

/** One keyboard action offered for a row, already checked against its position. */
export interface BacklogMoveAction {
  readonly id: string;
  readonly label: string;
  readonly move: BacklogMove;
  /** Row that should keep focus once the move lands. */
  readonly focusRowId: number | null;
}
