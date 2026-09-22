import { WORK_ITEM_TYPES } from "../../../domain/types";
import type { Priority, WorkItemType, WorkStatus } from "../../../domain/types";
import { LIST_STATUSES } from "./types";
import type { ListAssignee, ListItem, ListLabel, ListParticipant } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isParticipantKind(value: unknown): value is "human" | "agent" {
  return value === "human" || value === "agent";
}

function isWorkStatus(value: unknown): value is WorkStatus {
  return typeof value === "string" && LIST_STATUSES.some((status) => status === value);
}

function priorityFromValue(value: unknown): Priority | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3
    ? value as Priority
    : null;
}

function labelFromValue(value: unknown): ListLabel | null {
  if (!isRecord(value) || !isPositiveId(value.id) || typeof value.name !== "string") return null;
  return { id: value.id, name: value.name };
}

function assigneeFromValue(value: unknown): ListAssignee | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)
    || !isPositiveId(value.id)
    || typeof value.name !== "string"
    || !isParticipantKind(value.kind)) return undefined;
  return { id: value.id, name: value.name, kind: value.kind };
}

function itemFromValue(value: unknown): ListItem | null {
  if (!isRecord(value)
    || !isPositiveId(value.id)
    || typeof value.title !== "string"
    || !isWorkStatus(value.status)
    || typeof value.type !== "string"
    || !(WORK_ITEM_TYPES as readonly string[]).includes(value.type)
    || typeof value.backlogPosition !== "number"
    || !Number.isSafeInteger(value.backlogPosition)
    || value.backlogPosition < 0
    || !Array.isArray(value.labels)) return null;
  const priority = priorityFromValue(value.priority);
  const assignee = assigneeFromValue(value.assignee);
  if (priority === null || assignee === undefined) return null;
  const labels: ListLabel[] = [];
  for (const candidate of value.labels) {
    const label = labelFromValue(candidate);
    if (label === null) return null;
    labels.push(label);
  }
  return {
    id: value.id,
    title: value.title,
    status: value.status,
    type: value.type as WorkItemType,
    backlogPosition: value.backlogPosition,
    priority,
    assignee,
    labels,
  };
}

export interface ListPage {
  readonly items: readonly ListItem[];
  readonly nextCursor: string | null;
}

function isCanonicalCursor(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 2_048
    && /^[\x21-\x7e]+$/.test(value);
}

export function listPageFromResponse(response: unknown): ListPage | null {
  if (!isRecord(response) || !Array.isArray(response.data) || !isRecord(response.meta)) return null;
  const cursor = response.meta.nextCursor;
  if (cursor !== null && !isCanonicalCursor(cursor)) return null;
  const items: ListItem[] = [];
  const pageIds = new Set<number>();
  for (const candidate of response.data) {
    const item = itemFromValue(candidate);
    if (item === null || pageIds.has(item.id)) return null;
    pageIds.add(item.id);
    items.push(item);
  }
  return { items, nextCursor: cursor };
}

export function participantsFromResponse(response: unknown): readonly ListParticipant[] | null {
  if (!isRecord(response) || !Array.isArray(response.data)) return null;
  const participants: ListParticipant[] = [];
  for (const candidate of response.data) {
    if (!isRecord(candidate)
      || !isPositiveId(candidate.id)
      || typeof candidate.name !== "string"
      || !isParticipantKind(candidate.kind)) return null;
    participants.push({ id: candidate.id, name: candidate.name, kind: candidate.kind });
  }
  return participants;
}

export function labelsFromResponse(response: unknown): readonly ListLabel[] | null {
  if (!isRecord(response) || !Array.isArray(response.data)) return null;
  const labels: ListLabel[] = [];
  for (const candidate of response.data) {
    const label = labelFromValue(candidate);
    if (label === null) return null;
    labels.push(label);
  }
  return labels;
}
