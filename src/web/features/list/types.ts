import type { ParticipantKind, Priority, WorkStatus } from "../../../domain/types";

export const LIST_STATUSES = ["todo", "doing", "blocked", "done"] as const satisfies readonly WorkStatus[];

export interface ListFilters {
  status: string;
  assignee: string;
  label: string;
  q: string;
}

export interface ListLabel {
  readonly id: number;
  readonly name: string;
}

export interface ListParticipant {
  readonly id: number;
  readonly name: string;
  readonly kind: ParticipantKind;
}

export interface ListAssignee extends ListParticipant {}

/** The validated DTO subset consumed by the list UI. */
export interface ListItem {
  readonly id: number;
  readonly title: string;
  readonly status: WorkStatus;
  readonly priority: Priority;
  readonly assignee: ListAssignee | null;
  readonly labels: readonly ListLabel[];
}

export interface ListViewProps {
  params: Record<string, unknown>;
  refreshGeneration: number;
  onAuthenticationFailure: () => void;
}

export interface ListState {
  readonly items: readonly ListItem[];
  readonly participants: readonly ListParticipant[];
  readonly labels: readonly ListLabel[];
  readonly filters: ListFilters;
  readonly selected: ReadonlySet<number>;
  readonly nextCursor: string | null;
  readonly canLoadMore: boolean;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly bulkBusy: boolean;
  readonly error: string;
  readonly notice: string;
  readonly setFilter: (key: keyof ListFilters, value: string, commit?: boolean) => void;
  readonly setSearchDraft: (value: string) => void;
  readonly searchDraft: string;
  readonly clearFilters: () => void;
  readonly toggleSelected: (id: number, checked: boolean) => void;
  readonly toggleAll: (checked: boolean) => void;
  readonly clearSelection: () => void;
  readonly bulkAssign: (participantId: number | null) => void;
  readonly loadMore: () => void;
  readonly retry: () => void;
}
