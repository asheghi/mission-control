import type { ParticipantKind, Priority, WorkStatus } from "../../../domain/types";

export const BOARD_STATUSES = ["todo", "doing", "blocked", "done"] as const satisfies readonly WorkStatus[];

export const BOARD_COLUMN_LABELS: Record<WorkStatus, string> = {
  todo: "To do",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
};

export interface BoardLabel {
  readonly id: number;
  readonly name: string;
}

export interface BoardAssignee {
  readonly id: number;
  readonly name: string;
  readonly kind: ParticipantKind;
}

/** The validated DTO subset consumed by the board UI. */
export interface BoardItem {
  readonly id: number;
  readonly title: string;
  readonly status: WorkStatus;
  readonly priority: Priority;
  readonly labels: readonly BoardLabel[];
  readonly commentCount: number;
  readonly assignee: BoardAssignee | null;
}

export interface BoardViewProps {
  params: Record<string, unknown>;
  refreshGeneration: number;
  onAuthenticationFailure: () => void;
}

export type BoardFocusTarget = "title" | "status";

export interface BoardFocusRequest {
  id: number;
  target: BoardFocusTarget;
  sequence: number;
  /** Completion requests force a second restore after the optimistic request. */
  force: boolean;
}

export interface BoardState {
  items: readonly BoardItem[];
  loading: boolean;
  error: string;
  notice: string;
  focusRequest: BoardFocusRequest | null;
  movingItems: ReadonlySet<number>;
  quickAddBusy: ReadonlySet<WorkStatus>;
  refresh: () => void;
  moveItem: (id: number, status: WorkStatus, focusTarget?: BoardFocusTarget) => void;
  addItem: (status: WorkStatus, title: string) => Promise<boolean>;
}
