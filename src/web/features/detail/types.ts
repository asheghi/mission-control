import type { ParticipantKind, Priority, WorkStatus } from "../../../domain/types";
import type { ViewComponentProps } from "../../shell/types";

export const DETAIL_STATUSES = ["todo", "doing", "blocked", "done"] as const satisfies readonly WorkStatus[];
export const DETAIL_PRIORITIES = [0, 1, 2, 3] as const satisfies readonly Priority[];

// Server-side limits, mirrored so the client validates before it sends:
// `labelNameSchema` is a trimmed 1-64 character string and both item schemas
// bound the label array at 20 entries (src/domain/validation.ts and
// src/app/workboard.ts). A value that violates either is rejected as a 400.
export const TITLE_MAX_LENGTH = 256;
export const BODY_MAX_LENGTH = 100_000;
export const LABEL_NAME_MAX_LENGTH = 64;
export const LABEL_SET_MAX = 20;

export const DETAIL_LOAD_ERROR = "Could not load this item. Please try again.";
export const DETAIL_SAVE_ERROR = "Your change could not be saved. Please try again.";
export const DETAIL_DELETE_ERROR = "The item could not be deleted. Please try again.";
export const DETAIL_DELETE_FLUSH_ERROR = "Your latest edits could not be saved, so the item was not deleted.";
export const DETAIL_LABEL_ERROR = "Label changes could not be saved. Please try again.";
export const DETAIL_TITLE_NOTICE = "Title cannot be empty.";
export const DETAIL_TITLE_LIMIT_NOTICE = "Title must be 256 characters or fewer.";
export const DETAIL_BODY_NOTICE = "Description must be 100,000 characters or fewer.";
export const DETAIL_COMMENT_NOTICE = "Your comment could not be posted. Please try again.";
export const DETAIL_LABEL_LIMIT_NOTICE = "An item can have at most 20 labels.";
export const DETAIL_NOT_FOUND_NOTICE = "Saved data is shown, but the latest refresh failed.";
export const DETAIL_OPTIONS_NOTICE = "Some assignment or label options could not be loaded.";

// Diff rendering bounds. A collapsed history row must not compute an LCS at
// all, and an expanded one must stay bounded regardless of how large the stored
// description is.
export const DIFF_MAX_LINE_LENGTH = 400;
export const DIFF_MAX_RENDERED_LINES = 400;

export type BodyTab = "preview" | "edit";

export interface DetailParticipant {
  readonly id: number;
  readonly name: string;
  readonly kind: ParticipantKind;
}

export interface DetailLabel {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

export interface DetailItem {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly status: WorkStatus;
  readonly priority: Priority;
  readonly assignee: DetailParticipant | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly labels: readonly DetailLabel[];
}

export interface DetailComment {
  readonly id: number;
  readonly author: DetailParticipant;
  readonly body: string;
  readonly createdAt: string;
}

export interface DetailHistoryEntry {
  readonly id: number;
  readonly actorName: string;
  readonly field: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly createdAt: string;
}

export interface DetailPayload {
  readonly item: DetailItem;
  readonly comments: readonly DetailComment[];
  readonly history: readonly DetailHistoryEntry[];
}

export interface MentionTrigger {
  readonly start: number;
  readonly query: string;
}

export interface DiffOperation {
  readonly type: "ctx" | "add" | "del";
  readonly line: string;
}

export interface NormalizedLink {
  readonly href: string;
  readonly external: boolean;
}

export type InlineToken =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string }
  | { readonly kind: "em"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly link: NormalizedLink };

export interface MentionState {
  readonly trigger: MentionTrigger;
  readonly options: readonly DetailParticipant[];
  readonly activeIndex: number;
}

export interface DetailState {
  readonly id: number | null;
  readonly item: DetailItem | null;
  readonly comments: readonly DetailComment[];
  readonly history: readonly DetailHistoryEntry[];
  readonly participants: readonly DetailParticipant[];
  readonly labels: readonly DetailLabel[];
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly notFound: boolean;
  readonly error: string;
  readonly notice: string;
  readonly announcement: string;
  readonly titleDraft: string;
  readonly titleStatus: string;
  readonly bodyDraft: string;
  readonly bodyStatus: string;
  readonly bodyTab: BodyTab;
  readonly commentDraft: string;
  readonly commentBusy: boolean;
  readonly mention: MentionState | null;
  readonly labelDraft: string;
  readonly labelNotice: string;
  readonly selectedLabelNames: readonly string[];
  readonly labelsBusy: boolean;
  readonly deleting: boolean;
  readonly fieldsBusy: boolean;
  readonly expandedHistory: ReadonlySet<number>;
  readonly retry: () => void;
  readonly setTitleDraft: (value: string) => void;
  readonly flushTitle: () => Promise<void>;
  readonly setTitleFocused: (focused: boolean) => void;
  readonly setBodyDraft: (value: string) => void;
  readonly setBodyFocused: (focused: boolean) => void;
  readonly setBodyTab: (tab: BodyTab) => void;
  readonly patchField: (patch: { status?: WorkStatus; priority?: Priority; assigneeId?: number | null }) => void;
  readonly setLabelDraft: (value: string) => void;
  readonly addLabel: (name: string) => void;
  readonly removeLabel: (name: string) => void;
  readonly setCommentDraft: (value: string, caret: number) => void;
  readonly moveMention: (delta: number) => void;
  readonly closeMention: () => void;
  readonly chooseMention: (participant: DetailParticipant) => { value: string; caret: number } | null;
  readonly submitComment: () => void;
  readonly toggleHistory: (id: number) => void;
  readonly deleteItem: () => Promise<void>;
}

export interface DetailViewProps extends ViewComponentProps {}
