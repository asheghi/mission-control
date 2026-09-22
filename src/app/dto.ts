// Owned DTOs — the only shapes transports ever see. Database rows never cross
// the repository boundary un-mapped.
import type { ItemRelationshipName, ParticipantKind, Priority, WorkItemType, WorkStatus } from "../domain/types";
import type { CommentJoinedRow } from "../db/repositories/comments";
import type { HistoryJoinedRow } from "../db/repositories/history";
import type { ItemJoinedRow } from "../db/repositories/items";
import type { LabelRow } from "../db/repositories/labels";
import type { ParticipantRow } from "../db/repositories/participants";
import type { TokenRow } from "../db/repositories/tokens";

export interface ParticipantDto {
  readonly id: number;
  readonly name: string;
  readonly kind: ParticipantKind;
  readonly avatarColor: string;
  readonly createdAt: string;
}

export interface LabelDto {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly createdAt: string;
}

export interface AssigneeDto {
  readonly id: number;
  readonly name: string;
  readonly kind: ParticipantKind;
}

export interface ItemDto {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly status: WorkStatus;
  readonly priority: Priority;
  readonly type: WorkItemType;
  readonly assignee: AssigneeDto | null;
  readonly createdBy: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly parentId: number | null;
  /** Nonnegative sibling position; ordering is scoped to `parentId`. */
  readonly backlogPosition: number;
  readonly labels: LabelDto[];
  readonly commentCount: number;
}

/**
 * A non-hierarchical relationship between two items, named relative to the
 * item it was read from: `related`, `predecessor`, `successor`, `duplicate`,
 * or `duplicate_of`. `id` is the stored link, so removing a relationship only
 * ever needs this identifier.
 */
export interface ItemRelationshipDto {
  readonly id: number;
  readonly name: ItemRelationshipName;
  readonly item: ItemDto;
  readonly createdAt: string;
}

export interface MyWorkItemDto {
  readonly item: ItemDto;
  readonly assigned: boolean;
  readonly mentioned: boolean;
}

export interface CommentDto {
  readonly id: number;
  readonly itemId: number;
  readonly author: AssigneeDto;
  readonly body: string;
  readonly createdAt: string;
}

export interface HistoryEntryDto {
  readonly id: number;
  readonly itemId: number;
  readonly actorId: number;
  readonly actorName: string;
  readonly field: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly createdAt: string;
}

export interface TokenDto {
  readonly id: number;
  readonly participantId: number;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export function toParticipantDto(row: ParticipantRow): ParticipantDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    avatarColor: row.avatar_color,
    createdAt: row.created_at,
  };
}

export function toLabelDto(row: LabelRow): LabelDto {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
  };
}

export function toItemDto(row: ItemJoinedRow, labels: readonly LabelDto[]): ItemDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    priority: row.priority,
    type: row.work_item_type,
    assignee:
      row.assignee_id !== null && row.assignee_name !== null && row.assignee_kind !== null
        ? { id: row.assignee_id, name: row.assignee_name, kind: row.assignee_kind }
        : null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    parentId: row.parent_id,
    backlogPosition: row.backlog_position,
    labels: [...labels],
    commentCount: row.comment_count,
  };
}

export function toCommentDto(row: CommentJoinedRow): CommentDto {
  return {
    id: row.id,
    itemId: row.item_id,
    author: { id: row.author_id, name: row.author_name, kind: row.author_kind },
    body: row.body,
    createdAt: row.created_at,
  };
}

export function toHistoryEntryDto(row: HistoryJoinedRow): HistoryEntryDto {
  return {
    id: row.id,
    itemId: row.item_id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    createdAt: row.created_at,
  };
}

export function toTokenDto(row: TokenRow): TokenDto {
  return {
    id: row.id,
    participantId: row.participant_id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}
